import { Injectable } from '@angular/core';

type FaceApi = typeof import('face-api.js');

export class FaceRecognitionError extends Error {
  constructor(
    public readonly code: 'MODEL_LOAD_FAILED' | 'NO_FACE' | 'INVALID_CAPTURE' | 'CAMERA_NOT_READY',
    message: string
  ) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class FaceRecognitionService {
  private api: FaceApi | null = null;
  private loading: Promise<FaceApi> | null = null;

  async load(): Promise<FaceApi> {
    if (this.api) return this.api;
    if (this.loading) return this.loading;

    this.loading = import('face-api.js')
      .then(async api => {
        await api.nets.tinyFaceDetector.loadFromUri('/models');
        this.api = api;
        return api;
      })
      .catch(() => {
        this.loading = null;
        throw new FaceRecognitionError(
          'MODEL_LOAD_FAILED',
          'Face detection could not be loaded. Check the connection and retry.'
        );
      });

    return this.loading;
  }

  async detectSingleFace(video: HTMLVideoElement): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> {
    const api = await this.load();
    const detections = await api.detectAllFaces(
      video,
      new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.6 })
    );
    if (detections.length !== 1) return null;
    const box = detections[0].box;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  isStable(
    first: { x: number; y: number; width: number; height: number },
    second: { x: number; y: number; width: number; height: number },
    frameWidth: number,
    frameHeight: number
  ): boolean {
    if (!frameWidth || !frameHeight) return false;
    const centerDistance = Math.hypot(
      (first.x + first.width / 2 - second.x - second.width / 2) / frameWidth,
      (first.y + first.height / 2 - second.y - second.height / 2) / frameHeight
    );
    const widthRatio = first.width / Math.max(second.width, 1);
    return centerDistance <= 0.035 && widthRatio >= 0.82 && widthRatio <= 1.22;
  }

  captureImage(video: HTMLVideoElement): string {
    if (!video.videoWidth || !video.videoHeight) {
      throw new FaceRecognitionError('CAMERA_NOT_READY', 'Camera preview is not ready.');
    }

    const scale = Math.min(1, 1280 / video.videoWidth, 1280 / video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new FaceRecognitionError('INVALID_CAPTURE', 'Camera image could not be captured.');
    }

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      throw new FaceRecognitionError('INVALID_CAPTURE', 'Camera image could not be captured.');
    }
  }

  async captureFromStableFace(video: HTMLVideoElement): Promise<string> {
    const first = await this.detectSingleFace(video);
    if (!first) {
      throw new FaceRecognitionError('NO_FACE', 'Position one face inside the guide and hold still.');
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const second = await this.detectSingleFace(video);
    if (!second) {
      throw new FaceRecognitionError('NO_FACE', 'Keep one face inside the guide and retry.');
    }
    if (!this.isStable(first, second, video.videoWidth, video.videoHeight)) {
      throw new FaceRecognitionError('NO_FACE', 'Hold your face steady inside the guide and retry.');
    }
    return this.captureImage(video);
  }
}

import { Injectable } from '@angular/core';

type FaceApi = typeof import('face-api.js');

export class FaceRecognitionError extends Error {
  constructor(
    public readonly code: 'MODEL_LOAD_FAILED' | 'NO_FACE' | 'MULTIPLE_FACES' | 'INVALID_DESCRIPTOR',
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
        await Promise.all([
          api.nets.tinyFaceDetector.loadFromUri('/models'),
          api.nets.faceLandmark68Net.loadFromUri('/models'),
          api.nets.faceRecognitionNet.loadFromUri('/models')
        ]);
        this.api = api;
        return api;
      })
      .catch(error => {
        this.loading = null;
        throw new FaceRecognitionError(
          'MODEL_LOAD_FAILED',
          'Face recognition models could not be loaded. Check the connection and retry.'
        );
      });

    return this.loading;
  }

  async detectOneDescriptor(video: HTMLVideoElement): Promise<{
    descriptor: number[];
    box: { x: number; y: number; width: number; height: number };
  }> {
    const api = await this.load();
    const detections = await api
      .detectAllFaces(video, new api.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.6
      }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length === 0) {
      throw new FaceRecognitionError('NO_FACE', 'No face was detected. Position the member inside the guide.');
    }
    if (detections.length !== 1) {
      throw new FaceRecognitionError('MULTIPLE_FACES', 'More than one face is visible. Ensure only one person is in view.');
    }

    const descriptor = Array.from(detections[0].descriptor);
    if (
      descriptor.length !== 128 ||
      descriptor.some(value => !Number.isFinite(value) || Math.abs(value) > 2)
    ) {
      throw new FaceRecognitionError('INVALID_DESCRIPTOR', 'Face recognition could not produce a valid template.');
    }

    const box = detections[0].detection.box;
    return {
      descriptor,
      box: { x: box.x, y: box.y, width: box.width, height: box.height }
    };
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

  async descriptorFromStableFace(video: HTMLVideoElement): Promise<number[]> {
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
    return (await this.detectOneDescriptor(video)).descriptor;
  }
}

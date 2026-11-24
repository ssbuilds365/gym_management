import { Injectable } from '@angular/core';
import * as ort from 'onnxruntime-web/wasm';
import { environment } from '../../environments/environment';

type FaceBox = { x: number; y: number; width: number; height: number };
type FaceDetection = FaceBox & { x1: number; y1: number; x2: number; y2: number; score: number };

const MODEL_URL = '/models/face_detection_yunet_2026may.onnx';
const MAX_DETECTOR_DIMENSION = 640;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_DATA_URL_LENGTH = Math.ceil(MAX_CAPTURE_BYTES * 4 / 3) + 32;
const ENROLLMENT_SAMPLE_COUNT = 3;
const FEATURE_STRIDES = [8, 16, 32];
const SCORE_THRESHOLD = 0.9;
const NMS_THRESHOLD = 0.3;

const logDevelopmentDiagnostic = (event: string, details: Record<string, unknown> = {}): void => {
  if (!environment.production) {
    console.info('[biometric-debug]', event, details);
  }
};

const getFloatData = (tensor: ort.Tensor | undefined): Float32Array | undefined =>
  tensor?.type === 'float32' && tensor.data instanceof Float32Array
    ? tensor.data
    : undefined;

export class FaceRecognitionError extends Error {
  constructor(
    public readonly code:
      | 'MODEL_LOAD_FAILED'
      | 'NO_FACE'
      | 'INVALID_CAPTURE'
      | 'CAMERA_NOT_READY',
    message: string
  ) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class FaceRecognitionService {
  private session: ort.InferenceSession | null = null;
  private loading: Promise<void> | null = null;
  private inferenceQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.session) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = {
          mjs: '/assets/ort/ort-wasm-simd-threaded.mjs',
          wasm: '/assets/ort/ort-wasm-simd-threaded.wasm'
        };
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        if (
          session.inputNames[0] !== 'input' ||
          !session.outputNames.includes('cls_8') ||
          !session.outputNames.includes('kps_32')
        ) {
          await session.release();
          throw new Error('Configured YuNet model inputs or outputs do not match.');
        }
        this.session = session;
        logDevelopmentDiagnostic('detector-model-loaded', {
          model: 'YuNet',
          backend: 'onnxruntime-web-wasm'
        });
      } catch (error) {
        logDevelopmentDiagnostic('detector-model-load-failed', {
          code: error instanceof Error ? error.name : 'MODEL_LOAD_FAILED'
        });
        this.loading = null;
        throw new FaceRecognitionError(
          'MODEL_LOAD_FAILED',
          'Face detection could not be loaded. Check the connection and retry.'
        );
      }
    })();

    return this.loading;
  }

  async detectSingleFace(video: HTMLVideoElement): Promise<FaceBox | null> {
    await this.load();
    if (!video.videoWidth || !video.videoHeight || !this.session) return null;

    const previous = this.inferenceQueue;
    let release!: () => void;
    this.inferenceQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const detections = await this.detectFaces(video);
      logDevelopmentDiagnostic('browser-face-detection-complete', {
        count: detections.length,
        frameWidth: video.videoWidth,
        frameHeight: video.videoHeight,
        faceCrop: detections.length === 1
          ? {
              width: Math.round(detections[0].width),
              height: Math.round(detections[0].height)
            }
          : null
      });
      if (detections.length !== 1) return null;
      const { x, y, width, height } = detections[0];
      return { x, y, width, height };
    } finally {
      release();
    }
  }

  private async detectFaces(video: HTMLVideoElement): Promise<FaceDetection[]> {
    const scale = Math.min(1, MAX_DETECTOR_DIMENSION / video.videoWidth, MAX_DETECTOR_DIMENSION / video.videoHeight);
    const resizedWidth = Math.max(1, Math.round(video.videoWidth * scale));
    const resizedHeight = Math.max(1, Math.round(video.videoHeight * scale));
    const inputWidth = Math.ceil(resizedWidth / 32) * 32;
    const inputHeight = Math.ceil(resizedHeight / 32) * 32;
    const canvas = document.createElement('canvas');
    canvas.width = inputWidth;
    canvas.height = inputHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Face detection canvas is unavailable.');
    context.clearRect(0, 0, inputWidth, inputHeight);
    context.drawImage(video, 0, 0, resizedWidth, resizedHeight);
    const pixels = context.getImageData(0, 0, resizedWidth, resizedHeight).data;
    const planeSize = inputWidth * inputHeight;
    const inputData = new Float32Array(planeSize * 3);
    for (let y = 0; y < resizedHeight; y += 1) {
      for (let x = 0; x < resizedWidth; x += 1) {
        const source = (y * resizedWidth + x) * 4;
        const target = y * inputWidth + x;
        inputData[target] = pixels[source + 2];
        inputData[planeSize + target] = pixels[source + 1];
        inputData[planeSize * 2 + target] = pixels[source];
      }
    }

    const outputs = await this.session!.run({
      input: new ort.Tensor('float32', inputData, [1, 3, inputHeight, inputWidth])
    });
    const scaleX = resizedWidth / video.videoWidth;
    const scaleY = resizedHeight / video.videoHeight;
    const detections: FaceDetection[] = [];

    for (const stride of FEATURE_STRIDES) {
      const cls = getFloatData(outputs[`cls_${stride}`]);
      const obj = getFloatData(outputs[`obj_${stride}`]);
      const bbox = getFloatData(outputs[`bbox_${stride}`]);
      const keypoints = getFloatData(outputs[`kps_${stride}`]);
      const featureWidth = inputWidth / stride;
      const featureHeight = inputHeight / stride;
      const cells = featureWidth * featureHeight;
      if (
        !cls || !obj || !bbox || !keypoints ||
        cls.length !== cells || obj.length !== cells ||
        bbox.length !== cells * 4 || keypoints.length !== cells * 10
      ) {
        throw new Error('Face detection model returned invalid output.');
      }
      for (let index = 0; index < cells; index += 1) {
        const score = Math.sqrt(Math.max(0, cls[index]) * Math.max(0, obj[index]));
        if (score < SCORE_THRESHOLD) continue;
        const column = index % featureWidth;
        const row = Math.floor(index / featureWidth);
        const centerX = (column + bbox[index * 4]) * stride;
        const centerY = (row + bbox[index * 4 + 1]) * stride;
        const width = Math.exp(bbox[index * 4 + 2]) * stride;
        const height = Math.exp(bbox[index * 4 + 3]) * stride;
        const x1 = Math.max(0, Math.min(video.videoWidth, (centerX - width / 2) / scaleX));
        const y1 = Math.max(0, Math.min(video.videoHeight, (centerY - height / 2) / scaleY));
        const x2 = Math.max(0, Math.min(video.videoWidth, (centerX + width / 2) / scaleX));
        const y2 = Math.max(0, Math.min(video.videoHeight, (centerY + height / 2) / scaleY));
        if (x2 <= x1 || y2 <= y1) continue;
        detections.push({
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
          x1,
          y1,
          x2,
          y2,
          score
        });
      }
    }

    detections.sort((left, right) => right.score - left.score);
    const selected: FaceDetection[] = [];
    for (const candidate of detections.slice(0, 5000)) {
      if (selected.every(existing => this.intersectionOverUnion(existing, candidate) <= NMS_THRESHOLD)) {
        selected.push(candidate);
      }
    }
    return selected;
  }

  private intersectionOverUnion(left: FaceDetection, right: FaceDetection): number {
    const x1 = Math.max(left.x1, right.x1);
    const y1 = Math.max(left.y1, right.y1);
    const x2 = Math.min(left.x2, right.x2);
    const y2 = Math.min(left.y2, right.y2);
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const leftArea = (left.x2 - left.x1) * (left.y2 - left.y1);
    const rightArea = (right.x2 - right.x1) * (right.y2 - right.y1);
    return intersection / Math.max(leftArea + rightArea - intersection, 1e-12);
  }

  isStable(
    first: FaceBox,
    second: FaceBox,
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
      const image = canvas.toDataURL('image/jpeg', 0.85);
      logDevelopmentDiagnostic('camera-frame-captured', {
        width: canvas.width,
        height: canvas.height,
        encodedLength: image.length
      });
      return image;
    } catch {
      throw new FaceRecognitionError('INVALID_CAPTURE', 'Camera image could not be captured.');
    }
  }

  validateEnrollmentSamples(samples: unknown): void {
    const jpegDataUrl = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
    if (
      !Array.isArray(samples) ||
      samples.length !== ENROLLMENT_SAMPLE_COUNT ||
      samples.some((sample: unknown) =>
        typeof sample !== 'string' ||
        sample.length > MAX_CAPTURE_DATA_URL_LENGTH ||
        !jpegDataUrl.test(sample)
      )
    ) {
      throw new FaceRecognitionError(
        'INVALID_CAPTURE',
        'Three valid camera images are required. Capture the face again and retry.'
      );
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

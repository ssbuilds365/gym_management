const path = require('node:path');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODEL_DIRECTORY = path.join(__dirname, '..', 'models', 'onnx');
const YUNET_MODEL = path.join(MODEL_DIRECTORY, 'face_detection_yunet_2026may.onnx');
const SFACE_MODEL = path.join(MODEL_DIRECTORY, 'face_recognition_sface_2021dec.onnx');
const FACE_MODEL_VERSION = 'opencv-yunet-2026may-sface-2021dec-128d-v1';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 4_000_000;
const MAX_IMAGE_DIMENSION = 1280;
const MAX_DETECTOR_DIMENSION = 640;
const MIN_FACE_DIMENSION = 80;
const DETECTOR_SCORE_THRESHOLD = 0.9;
const DETECTOR_NMS_THRESHOLD = 0.3;
const FEATURE_STRIDES = [8, 16, 32];
const SFACE_REFERENCE_POINTS = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041]
];

let state = 'uninitialized';
let initializationPromise = null;
let detectorSession = null;
let recognizerSession = null;
let inferenceQueue = Promise.resolve();

class FaceRecognitionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'FaceRecognitionError';
    this.code = code;
    this.status = status;
  }
}

const isValidDescriptor = descriptor =>
  Array.isArray(descriptor) &&
  descriptor.length === 128 &&
  descriptor.every(value => Number.isFinite(value) && Math.abs(value) <= 2);

const normalizeDescriptor = descriptor => {
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    throw new FaceRecognitionError(
      'INVALID_FACE_DESCRIPTOR',
      'The face template could not be generated.'
    );
  }
  const norm = Math.sqrt(descriptor.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 1e-12) {
    throw new FaceRecognitionError(
      'INVALID_FACE_DESCRIPTOR',
      'The face template could not be generated.'
    );
  }
  const normalized = descriptor.map(value => value / norm);
  if (!isValidDescriptor(normalized)) {
    throw new FaceRecognitionError(
      'INVALID_FACE_DESCRIPTOR',
      'The face template could not be generated.'
    );
  }
  return normalized;
};

const withInferenceLock = async operation => {
  const previous = inferenceQueue;
  let release;
  inferenceQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

const initializeFaceRecognition = async () => {
  if (state === 'ready') return true;
  if (initializationPromise) return initializationPromise;

  state = 'loading';
  initializationPromise = (async () => {
    try {
      const options = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3
      };
      const [detector, recognizer] = await Promise.all([
        ort.InferenceSession.create(YUNET_MODEL, options),
        ort.InferenceSession.create(SFACE_MODEL, options)
      ]);
      if (
        detector.inputNames[0] !== 'input' ||
        !detector.outputNames.includes('cls_8') ||
        recognizer.inputNames[0] !== 'data' ||
        !recognizer.outputNames.includes('fc1')
      ) {
        await Promise.all([detector.release(), recognizer.release()]);
        throw new Error('Configured ONNX face model inputs or outputs do not match.');
      }
      detectorSession = detector;
      recognizerSession = recognizer;
      state = 'ready';
      console.info(`[biometric] ONNX CPU face models initialized (${FACE_MODEL_VERSION}).`);
      return true;
    } catch (error) {
      state = 'unavailable';
      console.error('[biometric] ONNX face model initialization failed:', {
        code: error?.code || error?.name || 'ONNX_MODEL_INITIALIZATION_FAILED'
      });
      return false;
    }
  })();
  return initializationPromise;
};

const isReady = () => state === 'ready';

const parseJpegDataUrl = image => {
  if (typeof image !== 'string' || image.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32) {
    throw new FaceRecognitionError('INVALID_FACE_IMAGE', 'A valid camera image is required.');
  }
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match) {
    throw new FaceRecognitionError('INVALID_FACE_IMAGE', 'A valid JPEG camera image is required.');
  }
  const buffer = Buffer.from(match[1], 'base64');
  if (
    buffer.length === 0 ||
    buffer.length > MAX_IMAGE_BYTES ||
    buffer.toString('base64') !== match[1]
  ) {
    throw new FaceRecognitionError('INVALID_FACE_IMAGE', 'The camera image is invalid or too large.');
  }
  return buffer;
};

const decodeImage = async image => {
  const input = parseJpegDataUrl(image);
  let decoded;
  try {
    decoded = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new FaceRecognitionError('INVALID_FACE_IMAGE', 'The camera image could not be processed.');
  }
  const { data, info } = decoded;
  if (
    info.width < MIN_FACE_DIMENSION ||
    info.height < MIN_FACE_DIMENSION ||
    info.channels !== 3
  ) {
    throw new FaceRecognitionError('INVALID_FACE_IMAGE', 'The camera image is invalid or too small.');
  }
  return { data, width: info.width, height: info.height };
};

const roundUpToStride = value => Math.ceil(value / 32) * 32;

const buildDetectorInput = async ({ data, width, height }) => {
  const resized = await sharp(data, { raw: { width, height, channels: 3 } })
    .resize({
      width: MAX_DETECTOR_DIMENSION,
      height: MAX_DETECTOR_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const resizedWidth = resized.info.width;
  const resizedHeight = resized.info.height;
  const inputWidth = roundUpToStride(resizedWidth);
  const inputHeight = roundUpToStride(resizedHeight);
  const planeSize = inputWidth * inputHeight;
  const inputData = new Float32Array(planeSize * 3);

  for (let y = 0; y < resizedHeight; y += 1) {
    for (let x = 0; x < resizedWidth; x += 1) {
      const sourceIndex = (y * resizedWidth + x) * 3;
      const targetIndex = y * inputWidth + x;
      inputData[targetIndex] = resized.data[sourceIndex];
      inputData[planeSize + targetIndex] = resized.data[sourceIndex + 1];
      inputData[planeSize * 2 + targetIndex] = resized.data[sourceIndex + 2];
    }
  }

  return {
    tensor: new ort.Tensor('float32', inputData, [1, 3, inputHeight, inputWidth]),
    inputWidth,
    inputHeight,
    scaleX: resizedWidth / width,
    scaleY: resizedHeight / height
  };
};

const intersectionOverUnion = (left, right) => {
  const x1 = Math.max(left.x1, right.x1);
  const y1 = Math.max(left.y1, right.y1);
  const x2 = Math.min(left.x2, right.x2);
  const y2 = Math.min(left.y2, right.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const leftArea = (left.x2 - left.x1) * (left.y2 - left.y1);
  const rightArea = (right.x2 - right.x1) * (right.y2 - right.y1);
  return intersection / Math.max(leftArea + rightArea - intersection, 1e-12);
};

const suppressOverlappingDetections = detections => {
  const candidates = detections.sort((left, right) => right.score - left.score).slice(0, 5000);
  const kept = [];
  for (const candidate of candidates) {
    if (kept.every(detection =>
      intersectionOverUnion(detection, candidate) <= DETECTOR_NMS_THRESHOLD
    )) {
      kept.push(candidate);
    }
  }
  return kept;
};

const decodeDetections = (outputs, inputWidth, inputHeight, scaleX, scaleY, sourceWidth, sourceHeight) => {
  const detections = [];
  for (const stride of FEATURE_STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data;
    const obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data;
    const keypoints = outputs[`kps_${stride}`]?.data;
    const featureWidth = inputWidth / stride;
    const featureHeight = inputHeight / stride;
    const cells = featureWidth * featureHeight;
    if (
      !cls || !obj || !bbox || !keypoints ||
      cls.length !== cells || obj.length !== cells ||
      bbox.length !== cells * 4 || keypoints.length !== cells * 10
    ) {
      throw new FaceRecognitionError(
        'BIOMETRIC_RECOGNITION_UNAVAILABLE',
        'Face recognition is temporarily unavailable.',
        503
      );
    }
    for (let index = 0; index < cells; index += 1) {
      const score = Math.sqrt(
        Math.max(0, Math.min(1, cls[index])) *
        Math.max(0, Math.min(1, obj[index]))
      );
      if (score < DETECTOR_SCORE_THRESHOLD) continue;

      const column = index % featureWidth;
      const row = Math.floor(index / featureWidth);
      const centerX = (column + bbox[index * 4]) * stride;
      const centerY = (row + bbox[index * 4 + 1]) * stride;
      const faceWidth = Math.exp(bbox[index * 4 + 2]) * stride;
      const faceHeight = Math.exp(bbox[index * 4 + 3]) * stride;
      const x1 = Math.max(0, Math.min(sourceWidth, (centerX - faceWidth / 2) / scaleX));
      const y1 = Math.max(0, Math.min(sourceHeight, (centerY - faceHeight / 2) / scaleY));
      const x2 = Math.max(0, Math.min(sourceWidth, (centerX + faceWidth / 2) / scaleX));
      const y2 = Math.max(0, Math.min(sourceHeight, (centerY + faceHeight / 2) / scaleY));
      if (x2 <= x1 || y2 <= y1) continue;

      const landmarks = [];
      for (let point = 0; point < 5; point += 1) {
        landmarks.push(
          (keypoints[index * 10 + point * 2] + column) * stride / scaleX,
          (keypoints[index * 10 + point * 2 + 1] + row) * stride / scaleY
        );
      }
      detections.push({ x1, y1, x2, y2, score, landmarks });
    }
  }
  return suppressOverlappingDetections(detections);
};

const detectFaces = async image => {
  const detectorInput = await buildDetectorInput(image);
  const outputs = await detectorSession.run({ input: detectorInput.tensor });
  return decodeDetections(
    outputs,
    detectorInput.inputWidth,
    detectorInput.inputHeight,
    detectorInput.scaleX,
    detectorInput.scaleY,
    image.width,
    image.height
  );
};

const estimateSimilarityTransform = landmarks => {
  if (!Array.isArray(landmarks) || landmarks.length !== 10 || !landmarks.every(Number.isFinite)) {
    throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
  }
  const sourcePoints = [];
  for (let index = 0; index < 5; index += 1) {
    sourcePoints.push([landmarks[index * 2], landmarks[index * 2 + 1]]);
  }
  const sourceMean = [0, 0];
  const targetMean = [0, 0];
  for (let index = 0; index < 5; index += 1) {
    sourceMean[0] += sourcePoints[index][0] / 5;
    sourceMean[1] += sourcePoints[index][1] / 5;
    targetMean[0] += SFACE_REFERENCE_POINTS[index][0] / 5;
    targetMean[1] += SFACE_REFERENCE_POINTS[index][1] / 5;
  }

  let denominator = 0;
  let aNumerator = 0;
  let bNumerator = 0;
  for (let index = 0; index < 5; index += 1) {
    const sourceX = sourcePoints[index][0] - sourceMean[0];
    const sourceY = sourcePoints[index][1] - sourceMean[1];
    const targetX = SFACE_REFERENCE_POINTS[index][0] - targetMean[0];
    const targetY = SFACE_REFERENCE_POINTS[index][1] - targetMean[1];
    denominator += sourceX * sourceX + sourceY * sourceY;
    aNumerator += sourceX * targetX + sourceY * targetY;
    bNumerator += sourceX * targetY - sourceY * targetX;
  }
  if (!Number.isFinite(denominator) || denominator <= 1e-12) {
    throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
  }

  const a = aNumerator / denominator;
  const b = bNumerator / denominator;
  const transform = {
    a,
    b,
    tx: targetMean[0] - a * sourceMean[0] + b * sourceMean[1],
    ty: targetMean[1] - b * sourceMean[0] - a * sourceMean[1]
  };
  if (![transform.a, transform.b, transform.tx, transform.ty].every(Number.isFinite)) {
    throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
  }
  return transform;
};

const alignFace = (image, landmarks) => {
  const transform = estimateSimilarityTransform(landmarks);
  const determinant = transform.a * transform.a + transform.b * transform.b;
  if (!Number.isFinite(determinant) || determinant <= 1e-12) {
    throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
  }
  const aligned = Buffer.alloc(112 * 112 * 3);
  for (let y = 0; y < 112; y += 1) {
    for (let x = 0; x < 112; x += 1) {
      const targetX = x - transform.tx;
      const targetY = y - transform.ty;
      const sourceX = (transform.a * targetX + transform.b * targetY) / determinant;
      const sourceY = (-transform.b * targetX + transform.a * targetY) / determinant;
      if (
        sourceX < 0 || sourceY < 0 ||
        sourceX > image.width - 1 || sourceY > image.height - 1
      ) continue;

      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const y1 = Math.min(image.height - 1, y0 + 1);
      const xWeight = sourceX - x0;
      const yWeight = sourceY - y0;
      const targetIndex = (y * 112 + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const topLeft = image.data[(y0 * image.width + x0) * 3 + channel];
        const topRight = image.data[(y0 * image.width + x1) * 3 + channel];
        const bottomLeft = image.data[(y1 * image.width + x0) * 3 + channel];
        const bottomRight = image.data[(y1 * image.width + x1) * 3 + channel];
        const top = topLeft + (topRight - topLeft) * xWeight;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        aligned[targetIndex + channel] = Math.round(top + (bottom - top) * yWeight);
      }
    }
  }
  return aligned;
};

const embeddingFromAlignedRgb = async alignedRgb => {
  if (!Buffer.isBuffer(alignedRgb) || alignedRgb.length !== 112 * 112 * 3) {
    throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
  }
  const planeSize = 112 * 112;
  const inputData = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    inputData[pixel] = alignedRgb[pixel * 3];
    inputData[planeSize + pixel] = alignedRgb[pixel * 3 + 1];
    inputData[planeSize * 2 + pixel] = alignedRgb[pixel * 3 + 2];
  }
  const result = await recognizerSession.run({
    data: new ort.Tensor('float32', inputData, [1, 3, 112, 112])
  });
  return normalizeDescriptor(Array.from(result.fc1.data));
};

const descriptorFromImage = async imageDataUrl => {
  if (!isReady()) {
    throw new FaceRecognitionError(
      'BIOMETRIC_RECOGNITION_UNAVAILABLE',
      'Face recognition is temporarily unavailable.',
      503
    );
  }
  const image = await decodeImage(imageDataUrl);
  return withInferenceLock(async () => {
    const detections = await detectFaces(image);
    if (detections.length === 0) {
      throw new FaceRecognitionError('NO_FACE', 'No face was detected in the camera image.', 422);
    }
    if (detections.length !== 1) {
      throw new FaceRecognitionError(
        'MULTIPLE_FACES',
        'Only one face may be present in the camera image.',
        422
      );
    }
    const face = detections[0];
    if (
      face.x2 - face.x1 < MIN_FACE_DIMENSION ||
      face.y2 - face.y1 < MIN_FACE_DIMENSION
    ) {
      throw new FaceRecognitionError(
        'FACE_TOO_SMALL',
        'Move closer to the camera and try again.',
        422
      );
    }
    return embeddingFromAlignedRgb(alignFace(image, face.landmarks));
  });
};

const descriptorFromImages = async images => {
  if (!Array.isArray(images) || images.length !== 3 || images.some(image => typeof image !== 'string')) {
    throw new FaceRecognitionError(
      'INVALID_FACE_IMAGES',
      'Three camera samples are required for face registration.'
    );
  }
  const descriptors = [];
  for (const image of images) {
    descriptors.push(await descriptorFromImage(image));
  }
  const averaged = descriptors[0].map((_, index) =>
    descriptors.reduce((sum, descriptor) => sum + descriptor[index], 0) / descriptors.length
  );
  return normalizeDescriptor(averaged);
};

const disposeFaceRecognition = async () => {
  await inferenceQueue;
  const sessions = [detectorSession, recognizerSession].filter(Boolean);
  detectorSession = null;
  recognizerSession = null;
  state = 'uninitialized';
  initializationPromise = null;
  await Promise.all(sessions.map(session => session.release()));
};

module.exports = {
  FACE_MODEL_VERSION,
  FaceRecognitionError,
  initializeFaceRecognition,
  disposeFaceRecognition,
  getBackend: () => (isReady() ? 'onnxruntime-cpu' : null),
  isReady,
  descriptorFromImage,
  descriptorFromImages,
  isValidDescriptor,
  normalizeDescriptor,
  estimateSimilarityTransform,
  embeddingFromAlignedRgb
};

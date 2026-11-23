const path = require('node:path');
const tf = require('@tensorflow/tfjs');
const faceapi = require('face-api.js');
const sharp = require('sharp');

const MODEL_DIRECTORY = path.join(__dirname, '..', 'models', 'face-api');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 4_000_000;
const MAX_IMAGE_DIMENSION = 1280;
const MIN_FACE_DIMENSION = 80;

let state = 'uninitialized';
let initializationPromise = null;

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

const initializeFaceRecognition = async () => {
  if (state === 'ready') return true;
  if (initializationPromise) return initializationPromise;

  state = 'loading';
  initializationPromise = (async () => {
    try {
      await tf.setBackend('cpu');
      await tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIRECTORY),
        faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIRECTORY),
        faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIRECTORY)
      ]);
      state = 'ready';
      console.info('[biometric] face recognition models initialized.');
      return true;
    } catch (error) {
      state = 'unavailable';
      console.error('[biometric] face recognition initialization failed:', {
        code: error?.code || error?.name || 'MODEL_INITIALIZATION_FAILED'
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

const descriptorFromImage = async image => {
  if (!isReady()) {
    throw new FaceRecognitionError(
      'BIOMETRIC_RECOGNITION_UNAVAILABLE',
      'Face recognition is temporarily unavailable.',
      503
    );
  }
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

  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  try {
    const detections = await faceapi
      .detectAllFaces(tensor, new faceapi.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.6
      }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length === 0) {
      throw new FaceRecognitionError('NO_FACE', 'No face was detected in the camera image.', 422);
    }
    if (detections.length !== 1) {
      throw new FaceRecognitionError('MULTIPLE_FACES', 'Only one face may be present in the camera image.', 422);
    }
    const box = detections[0].detection.box;
    if (box.width < MIN_FACE_DIMENSION || box.height < MIN_FACE_DIMENSION) {
      throw new FaceRecognitionError('FACE_TOO_SMALL', 'Move closer to the camera and try again.', 422);
    }
    const descriptor = Array.from(detections[0].descriptor);
    if (!isValidDescriptor(descriptor)) {
      throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
    }
    return descriptor;
  } finally {
    tensor.dispose();
  }
};

const descriptorFromImages = async images => {
  if (!Array.isArray(images) || images.length !== 3) {
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
  if (!isValidDescriptor(averaged)) {
    throw new FaceRecognitionError('INVALID_FACE_TEMPLATE', 'The face image could not be processed.');
  }
  return averaged;
};

module.exports = {
  FaceRecognitionError,
  initializeFaceRecognition,
  isReady,
  descriptorFromImage,
  descriptorFromImages,
  isValidDescriptor
};

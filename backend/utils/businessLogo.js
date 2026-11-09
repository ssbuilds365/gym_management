const sharp = require('sharp');

const MAX_ORIGINAL_BYTES = 200 * 1024;
const MAX_COMPRESSED_BYTES = 100 * 1024;
const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const compressBusinessLogo = async (input, contentType) => {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    const error = new Error('Select a valid JPG, PNG, or WebP logo image.');
    error.statusCode = 400;
    throw error;
  }
  if (input.length > MAX_ORIGINAL_BYTES) {
    const error = new Error('Logo image must be 200 KB or smaller.');
    error.statusCode = 413;
    throw error;
  }
  if (!SUPPORTED_MIME_TYPES.has(String(contentType || '').toLowerCase())) {
    const error = new Error('Logo must be a JPG, PNG, or WebP image.');
    error.statusCode = 415;
    throw error;
  }

  let metadata;
  try {
    metadata = await sharp(input, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
  } catch {
    const error = new Error('The selected file is not a valid image.');
    error.statusCode = 400;
    throw error;
  }

  const contentTypesByFormat = {
    jpeg: ['image/jpeg', 'image/jpg'],
    png: ['image/png'],
    webp: ['image/webp']
  };
  if (
    !contentTypesByFormat[metadata.format]
    || !contentTypesByFormat[metadata.format].includes(String(contentType).toLowerCase())
    || !metadata.width
    || !metadata.height
  ) {
    const error = new Error('The selected file content does not match a supported image format.');
    error.statusCode = 415;
    throw error;
  }

  const dimensionTargets = [300, 260, 220, 180, 160];
  const qualityTargets = [85, 78, 70, 62, 55];
  let smallestUnderLimit;
  for (const dimension of dimensionTargets) {
    for (const quality of qualityTargets) {
      const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 40_000_000 })
        .rotate()
        .resize({
          width: dimension,
          height: dimension,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });

      if (data.length <= MAX_COMPRESSED_BYTES && (
        !smallestUnderLimit || data.length < smallestUnderLimit.data.length
      )) {
        smallestUnderLimit = { data, info };
      }
      if (data.length <= 80 * 1024) {
        return {
          buffer: data,
          width: info.width,
          height: info.height,
          format: 'webp',
          bytes: data.length
        };
      }
    }
  }

  if (smallestUnderLimit) {
    return {
      buffer: smallestUnderLimit.data,
      width: smallestUnderLimit.info.width,
      height: smallestUnderLimit.info.height,
      format: 'webp',
      bytes: smallestUnderLimit.data.length
    };
  }

  const error = new Error('This logo cannot be compressed below 100 KB without reducing its quality too much. Choose a simpler or smaller image.');
  error.statusCode = 413;
  throw error;
};

module.exports = {
  MAX_COMPRESSED_BYTES,
  MAX_ORIGINAL_BYTES,
  compressBusinessLogo
};

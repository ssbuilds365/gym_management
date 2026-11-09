const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  MAX_COMPRESSED_BYTES,
  MAX_ORIGINAL_BYTES,
  compressBusinessLogo
} = require('../utils/businessLogo');

const createImage = (format, options = {}) => {
  const { width = 640, height = 480 } = options;
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 45, g: 105, b: 175, alpha: 0.75 }
    }
  })[format]().toBuffer();
};

test('compresses valid JPEG, PNG and WebP logos to bounded WebP dimensions', async () => {
  for (const [format, mimeType] of [
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp']
  ]) {
    const output = await compressBusinessLogo(await createImage(format), mimeType);
    const metadata = await sharp(output.buffer).metadata();
    assert.equal(output.format, 'webp');
    assert.equal(metadata.format, 'webp');
    assert.ok(output.width <= 300 && output.height <= 300);
    assert.ok(output.bytes <= MAX_COMPRESSED_BYTES);
    assert.ok(Math.abs(output.width / output.height - 640 / 480) < 0.02);
    if (format === 'png') assert.equal(metadata.hasAlpha, true);
  }
});

test('rejects original image files larger than 200 KB before decoding', async () => {
  await assert.rejects(
    compressBusinessLogo(Buffer.alloc(MAX_ORIGINAL_BYTES + 1), 'image/png'),
    error => error.statusCode === 413 && /200 KB or smaller/.test(error.message)
  );
});

test('rejects invalid image content and mismatched MIME types', async () => {
  await assert.rejects(
    compressBusinessLogo(Buffer.from('not an image'), 'image/png'),
    error => error.statusCode === 400 && /not a valid image/.test(error.message)
  );
  await assert.rejects(
    compressBusinessLogo(await createImage('png'), 'image/jpeg'),
    error => error.statusCode === 415 && /does not match/.test(error.message)
  );
});

test('rejects unsupported MIME types without accepting arbitrary content', async () => {
  await assert.rejects(
    compressBusinessLogo(await createImage('png'), 'application/octet-stream'),
    error => error.statusCode === 415
  );
});

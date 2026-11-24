const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const faceRecognition = require('../services/faceRecognition');

test('backend face models initialize and reject an image without a face', { timeout: 120000 }, async () => {
  assert.equal(await faceRecognition.initializeFaceRecognition(), true);
  assert.equal(faceRecognition.isReady(), true);
  assert.equal(faceRecognition.getBackend(), 'onnxruntime-cpu');

  const image = await sharp({
    create: {
      width: 160,
      height: 160,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  }).jpeg().toBuffer();

  await assert.rejects(
    faceRecognition.descriptorFromImage(`data:image/jpeg;base64,${image.toString('base64')}`),
    error => error.code === 'NO_FACE' && error.status === 422
  );
});

test('backend face inference rejects arbitrary image encodings', async () => {
  assert.equal(await faceRecognition.initializeFaceRecognition(), true);
  await assert.rejects(
    faceRecognition.descriptorFromImage('data:image/png;base64,AAAA'),
    error => error.code === 'INVALID_FACE_IMAGE' && error.status === 400
  );
});

test('YuNet receives decoded RGB camera pixels in BGR model order', async () => {
  const { tensor, inputWidth, inputHeight } = await faceRecognition.buildDetectorInput({
    data: Buffer.from([11, 22, 33]),
    width: 1,
    height: 1
  });
  const planeSize = inputWidth * inputHeight;

  assert.equal(tensor.data[0], 33);
  assert.equal(tensor.data[planeSize], 22);
  assert.equal(tensor.data[planeSize * 2], 11);
});

test('SFace CPU inference returns a normalized 128-value embedding', async () => {
  assert.equal(await faceRecognition.initializeFaceRecognition(), true);
  const descriptor = await faceRecognition.embeddingFromAlignedRgb(
    Buffer.alloc(112 * 112 * 3, 127)
  );
  assert.equal(descriptor.length, 128);
  assert.ok(descriptor.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...descriptor) - 1) < 1e-5);
  assert.equal(faceRecognition.isNormalizedDescriptor(descriptor), true);
});

test('face templates reject wrong dimensions, non-finite values, and zero vectors', () => {
  assert.equal(faceRecognition.isValidDescriptor(Array(127).fill(0.1)), false);
  assert.equal(faceRecognition.isValidDescriptor([NaN, ...Array(127).fill(0)]), false);
  assert.equal(faceRecognition.isValidDescriptor([Infinity, ...Array(127).fill(0)]), false);
  assert.equal(faceRecognition.isValidDescriptor(Array(128).fill(0)), false);
  assert.throws(
    () => faceRecognition.assertGeneratedDescriptor(Array(128).fill(0.1)),
    error => error.code === 'INVALID_FACE_DESCRIPTOR' && error.status === 503
  );
});

test('descriptor diagnostics identify only safe validation metadata', () => {
  const cases = [
    [Array(127).fill(0.1), 'wrong-dimension'],
    [[NaN, ...Array(127).fill(0)], 'non-finite-or-nonnumeric-value'],
    [[3, ...Array(127).fill(0)], 'value-out-of-range'],
    [Array(128).fill(0), 'zero-or-invalid-norm']
  ];
  const sparseDescriptor = Array(128).fill(0.1);
  delete sparseDescriptor[4];
  cases.push([sparseDescriptor, 'non-finite-or-nonnumeric-value']);
  cases.push([[undefined, ...Array(127).fill(0.1)], 'non-finite-or-nonnumeric-value']);

  for (const [descriptor, expectedReason] of cases) {
    const diagnostics = faceRecognition.inspectDescriptor(descriptor);
    assert.equal(diagnostics.valid, false);
    assert.equal(diagnostics.reason, expectedReason);
    assert.equal(Object.hasOwn(diagnostics, 'descriptor'), false);
    assert.equal(Object.hasOwn(diagnostics, 'values'), false);
  }
});

test('face model alignment rejects malformed landmark coordinates', () => {
  assert.throws(
    () => faceRecognition.estimateSimilarityTransform([1, 2, 3]),
    error => error.code === 'INVALID_FACE_TEMPLATE'
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const faceRecognition = require('../services/faceRecognition');

test('backend face models initialize and reject an image without a face', { timeout: 120000 }, async () => {
  assert.equal(await faceRecognition.initializeFaceRecognition(), true);
  assert.equal(faceRecognition.isReady(), true);
  assert.equal(
    faceRecognition.getBackend(),
    faceRecognition.isNativeBackendAvailable() ? 'tensorflow' : 'cpu'
  );

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

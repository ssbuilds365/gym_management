const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { buildCorsOptions } = require('../utils/corsConfig');

const allowedOrigins = [
  'http://localhost:4200',
  'https://gym-management-chi-three.vercel.app'
];

test('CORS allows local and Vercel origins with credentials', async () => {
  const app = express();
  app.use(cors(buildCorsOptions(allowedOrigins)));
  app.post('/api/members/import/confirm', (req, res) => {
    res.json({ success: true });
  });

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const origin of allowedOrigins) {
      const preflight = await fetch(`${baseUrl}/api/members/import/confirm`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization,accept,idempotency-key'
        }
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
      assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
      assert.match(
        preflight.headers.get('access-control-allow-headers').toLowerCase(),
        /idempotency-key/
      );
    }

    const rejected = await fetch(`${baseUrl}/api/members/import/confirm`, {
      method: 'POST',
      headers: { Origin: 'https://unknown.example' }
    });
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);

    const importConfirmation = await fetch(`${baseUrl}/api/members/import/confirm`, {
      method: 'POST',
      headers: {
        Origin: 'https://gym-management-chi-three.vercel.app',
        'Content-Type': 'application/json',
        Authorization: 'Bearer test',
        'Idempotency-Key': 'test-import-key'
      }
    });
    assert.equal(importConfirmation.status, 200);
    assert.equal(
      importConfirmation.headers.get('access-control-allow-origin'),
      'https://gym-management-chi-three.vercel.app'
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    );
  }
});

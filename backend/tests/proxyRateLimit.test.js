const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { rateLimit } = require('express-rate-limit');
const { configureProxyTrust } = require('../utils/proxyTrust');

const createRateLimitedApp = (nodeEnv, includeRateLimit = true) => {
  const app = express();
  configureProxyTrust(app, nodeEnv);
  if (includeRateLimit) {
    app.use(rateLimit({
      windowMs: 60_000,
      limit: 1,
      standardHeaders: true,
      legacyHeaders: false
    }));
  }
  app.get('/', (req, res) => res.status(200).send(req.ip));
  return app;
};

const listen = server => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = server => new Promise((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
});

test('production trusts one proxy hop and spoofed forwarding headers cannot reset rate limits', async () => {
  const appServer = http.createServer(createRateLimitedApp('production'));
  const appPort = await listen(appServer);

  const ingress = http.createServer((req, res) => {
    const forwardedFor = [
      req.headers['x-forwarded-for'],
      req.socket.remoteAddress
    ].filter(Boolean).join(', ');
    const proxyRequest = http.request({
      hostname: '127.0.0.1',
      port: appPort,
      path: req.url,
      method: req.method,
      headers: {
        'x-forwarded-for': forwardedFor,
        forwarded: req.headers.forwarded || ''
      }
    }, proxyResponse => {
      res.writeHead(proxyResponse.statusCode, proxyResponse.headers);
      proxyResponse.pipe(res);
    });
    proxyRequest.on('error', error => {
      res.writeHead(502);
      res.end(error.message);
    });
    req.pipe(proxyRequest);
  });
  const ingressPort = await listen(ingress);
  const url = `http://127.0.0.1:${ingressPort}/`;

  try {
    const first = await fetch(url, {
      headers: {
        'x-forwarded-for': '198.51.100.10',
        forwarded: 'for=198.51.100.10'
      }
    });
    const second = await fetch(url, {
      headers: {
        'x-forwarded-for': '203.0.113.20',
        forwarded: 'for=203.0.113.20'
      }
    });

    assert.equal(first.status, 200);
    assert.equal(await first.text(), '127.0.0.1');
    assert.equal(second.status, 429);
  } finally {
    await close(ingress);
    await close(appServer);
  }
});

test('development does not trust forwarded client IP headers', async () => {
  const server = http.createServer(createRateLimitedApp('development', false));
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        'x-forwarded-for': '198.51.100.10',
        forwarded: 'for=198.51.100.10'
      }
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '127.0.0.1');
  } finally {
    await close(server);
  }
});

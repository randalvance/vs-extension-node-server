'use strict';

/**
 * Tests for the traffic recording that backs the inspector UI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');

const { ProxyServer } = require('../src/proxy');
const { TrafficRecorder, toSummary } = require('../src/traffic-recorder');
const { previewBody } = require('../src/body-preview');
const { buildDetail } = require('../src/transaction-detail');
const { allHeaders } = require('../src/headers');

const silent = { logLevel: 'silent' };

async function startProxy(overrides = {}) {
  const proxy = new ProxyServer({ port: 0, ...silent, ...overrides }, { env: {} });
  await proxy.start();
  proxy.recorder.setEnabled(true);
  return proxy;
}

function requestThroughProxy(proxy, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const address = proxy.address();
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        method: options.method || 'GET',
        path: targetUrl,
        headers: { Host: new URL(targetUrl).host, ...(options.headers || {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ----------------------------------------------------------------- recorder

test('records nothing while disabled', () => {
  const recorder = new TrafficRecorder();
  assert.equal(recorder.enabled, false);
  assert.equal(recorder.begin({ kind: 'http', method: 'GET' }), null);
  assert.equal(recorder.size, 0);

  // Every method tolerates the null handle, so callers need no branches.
  assert.doesNotThrow(() => {
    recorder.appendRequestBody(null, Buffer.from('x'));
    recorder.markConnected(null, '1.2.3.4');
    recorder.setResponse(null, { statusCode: 200 });
    recorder.finish(null, {});
  });
});

test('caps retained bodies and flags the truncation', () => {
  const recorder = new TrafficRecorder({ enabled: true, maxBodyBytes: 10 });
  const record = recorder.begin({ kind: 'http', method: 'POST' });

  recorder.appendRequestBody(record, Buffer.from('12345'));
  recorder.appendRequestBody(record, Buffer.from('67890EXTRA'));

  assert.equal(record.request.bytes, 15, 'counts every byte that passed through');
  assert.equal(Buffer.concat(record.request.chunks).length, 10, 'retains only the cap');
  assert.equal(record.request.truncated, true);
});

test('counts bytes but keeps nothing when body capture is off', () => {
  const recorder = new TrafficRecorder({ enabled: true, captureBodies: false });
  const record = recorder.begin({ kind: 'http', method: 'POST' });
  recorder.appendRequestBody(record, Buffer.from('hello'));

  assert.equal(record.request.bytes, 5);
  assert.equal(record.request.chunks.length, 0);
  assert.equal(previewBody(record.request, {}).kind, 'not-captured');
});

test('evicts the oldest transactions past the cap', () => {
  const recorder = new TrafficRecorder({ enabled: true, maxEntries: 3 });
  const evicted = [];
  recorder.on('evict', (id) => evicted.push(id));

  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(recorder.begin({ kind: 'http', method: 'GET' }).id);

  assert.equal(recorder.size, 3);
  assert.deepEqual(evicted, [ids[0], ids[1]]);
  assert.equal(recorder.get(ids[0]), null);
  assert.equal(recorder.get(ids[4]).id, ids[4]);
});

test('redacts credentials out of captured headers', () => {
  const headers = allHeaders([
    'Proxy-Authorization', 'Basic c2VjcmV0',
    'Authorization', 'Bearer token',
    'Accept', '*/*',
  ]);
  assert.equal(headers['Proxy-Authorization'], '<redacted>');
  assert.equal(headers.Authorization, '<redacted>');
  assert.equal(headers.Accept, '*/*');
});

// ------------------------------------------------------------- body preview

test('decompresses gzip bodies for display', () => {
  const side = { chunks: [zlib.gzipSync(Buffer.from('{"a":1}'))], bytes: 27, truncated: false };
  const preview = previewBody(side, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });

  assert.equal(preview.kind, 'json');
  assert.equal(preview.text, '{\n  "a": 1\n}');
  assert.match(preview.note, /decompressed from gzip/);
});

test('says so instead of failing when a compressed body was truncated', () => {
  const truncated = zlib.gzipSync(Buffer.from('hello world')).subarray(0, 8);
  const side = { chunks: [truncated], bytes: 31, truncated: true };
  const preview = previewBody(side, { 'Content-Encoding': 'gzip' });

  assert.match(preview.note, /capture was incomplete/);
});

test('hex-dumps binary bodies rather than mangling them', () => {
  const side = { chunks: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])], bytes: 6, truncated: false };
  const preview = previewBody(side, { 'Content-Type': 'image/png' });

  assert.equal(preview.kind, 'binary');
  assert.match(preview.text, /89 50 4e 47/);
});

test('reads plain text and pretty-prints JSON', () => {
  const text = previewBody(
    { chunks: [Buffer.from('hello')], bytes: 5, truncated: false },
    { 'Content-Type': 'text/plain' },
  );
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'hello');

  const json = previewBody(
    { chunks: [Buffer.from('{"b":[1,2]}')], bytes: 11, truncated: false },
    { 'Content-Type': 'application/json' },
  );
  assert.equal(json.kind, 'json');
  assert.equal(json.text, '{\n  "b": [\n    1,\n    2\n  ]\n}');
});

// ------------------------------------------------------------ through proxy

test('captures a full HTTP exchange end to end', async (t) => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Echo': body });
      res.end(JSON.stringify({ received: body }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  const url = `http://127.0.0.1:${upstream.address().port}/submit?q=1`;
  await requestThroughProxy(proxy, url, {
    method: 'POST',
    body: 'ping',
    headers: { 'Content-Type': 'text/plain', 'X-Trace': 'abc' },
  });

  const [record] = proxy.recorder.list();
  const detail = buildDetail(record);

  assert.equal(detail.method, 'POST');
  assert.equal(detail.host, '127.0.0.1');
  assert.equal(detail.path, '/submit?q=1');
  assert.equal(detail.statusCode, 201);
  assert.equal(detail.state, 'complete');
  assert.equal(detail.requestHeaders['X-Trace'], 'abc');
  assert.equal(detail.responseHeaders['X-Echo'], 'ping');
  assert.equal(detail.requestBody.text, 'ping');
  assert.equal(JSON.parse(detail.responseBody.text).received, 'ping');
  assert.equal(detail.remoteAddress, '127.0.0.1');
  assert.ok(detail.timing.totalMs >= 0);
  assert.equal(detail.tunnelNote, null);
});

test('records blocked requests, with the reason they were refused', async (t) => {
  const proxy = await startProxy({ denyHosts: ['*.forbidden.test'] });
  t.after(() => proxy.stop());

  await requestThroughProxy(proxy, 'http://api.forbidden.test/secrets');

  const [record] = proxy.recorder.list();
  const summary = toSummary(record);

  assert.equal(summary.state, 'blocked');
  assert.equal(summary.statusCode, 403);
  assert.equal(summary.host, 'api.forbidden.test');
  assert.match(summary.blockedReason, /deny rule/);
});

test('records a rejected tunnel and one that carried traffic', async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));

  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    echo.close();
  });

  const address = proxy.address();
  const tunnel = (authority) =>
    new Promise((resolve, reject) => {
      const req = http.request({
        host: address.host,
        port: address.port,
        method: 'CONNECT',
        path: authority,
      });
      req.on('connect', (res, socket) => resolve({ statusCode: res.statusCode, socket }));
      req.on('error', reject);
      req.end();
    });

  // One that succeeds and moves bytes.
  const good = await tunnel(`127.0.0.1:${echo.address().port}`);
  assert.equal(good.statusCode, 200);
  await new Promise((resolve) => {
    good.socket.on('data', resolve);
    good.socket.write('twelve bytes');
  });
  good.socket.destroy();

  // One the port allowlist would never see: an unroutable target.
  const bad = await tunnel('198.51.100.1:9');
  bad.socket.destroy();

  await new Promise((resolve) => setTimeout(resolve, 50));

  const records = proxy.recorder.list();
  assert.equal(records.length, 2);

  const carried = buildDetail(records[0]);
  assert.equal(carried.kind, 'connect');
  assert.equal(carried.method, 'CONNECT');
  assert.equal(carried.statusCode, 200);
  assert.ok(carried.bytesUp >= 12, `expected bytes to be counted, got ${carried.bytesUp}`);
  assert.equal(carried.requestBody, null, 'a tunnel has no readable body');
  assert.match(carried.tunnelNote, /TLS-encrypted/);
});

test('summaries carry no body payload', async (t) => {
  const upstream = http.createServer((req, res) => res.end('x'.repeat(5000)));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.address().port}/`);

  const summary = toSummary(proxy.recorder.list()[0]);
  const serialized = JSON.stringify(summary);

  assert.ok(!serialized.includes('xxxx'), 'the list payload must not carry bodies');
  assert.equal(summary.responseBytes, 5000);
  assert.ok(serialized.length < 600, `summary should stay small, was ${serialized.length} bytes`);
});

test('clearing drops everything and notifies listeners', async (t) => {
  const proxy = await startProxy({ denyHosts: ['*'] });
  t.after(() => proxy.stop());

  await requestThroughProxy(proxy, 'http://anything.test/');
  assert.equal(proxy.recorder.size, 1);

  let cleared = false;
  proxy.recorder.on('cleared', () => {
    cleared = true;
  });
  proxy.recorder.clear();

  assert.equal(proxy.recorder.size, 0);
  assert.equal(cleared, true);
  assert.deepEqual(proxy.recorder.list(), []);
});

test('recording off means the proxy still works and retains nothing', async (t) => {
  const upstream = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const proxy = await startProxy({ allowPrivateNetworks: true });
  proxy.recorder.setEnabled(false);
  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  const response = await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.address().port}/`);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'ok');
  assert.equal(proxy.recorder.size, 0);
});

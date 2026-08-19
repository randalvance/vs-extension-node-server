'use strict';

/**
 * Tests for HAR 1.2 export.
 *
 * The point of HAR is that other tools read it, so most of these assert the
 * spec's invariants rather than our own preferences — a file that only we can
 * parse would defeat the exercise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { toHar, toEntry, harTimings, totalTime } = require('../src/har');
const { TrafficRecorder } = require('../src/traffic-recorder');
const { ProxyServer } = require('../src/proxy');

function recorder() {
  return new TrafficRecorder({ enabled: true });
}

function httpRecord(rec, overrides = {}) {
  const record = rec.begin({
    kind: 'http',
    method: 'GET',
    url: 'http://example.com/api/thing?page=2&q=hi',
    scheme: 'http',
    host: 'example.com',
    port: 80,
    path: '/api/thing?page=2&q=hi',
    httpVersion: '1.1',
    requestHeaders: { Accept: 'application/json', Cookie: 'sid=abc; theme=dark' },
    ...overrides,
  });
  return record;
}

/** The structural rules a HAR consumer relies on. */
function assertValidHar(har) {
  assert.equal(har.log.version, '1.2');
  assert.ok(har.log.creator.name, 'creator.name is required');
  assert.ok(har.log.creator.version, 'creator.version is required');
  assert.ok(Array.isArray(har.log.entries));

  for (const entry of har.log.entries) {
    assert.ok(
      !Number.isNaN(Date.parse(entry.startedDateTime)),
      `startedDateTime must be a valid date, got ${entry.startedDateTime}`,
    );
    assert.equal(typeof entry.time, 'number');

    for (const side of ['request', 'response']) {
      const message = entry[side];
      assert.ok(Array.isArray(message.headers), `${side}.headers must be an array`);
      assert.ok(Array.isArray(message.cookies), `${side}.cookies must be an array`);
      for (const header of message.headers) {
        assert.equal(typeof header.name, 'string');
        assert.equal(typeof header.value, 'string');
      }
      assert.equal(typeof message.headersSize, 'number');
      assert.equal(typeof message.bodySize, 'number');
    }

    assert.ok(Array.isArray(entry.request.queryString));
    assert.equal(typeof entry.request.method, 'string');
    assert.equal(typeof entry.request.url, 'string');
    assert.equal(typeof entry.response.status, 'number');
    assert.equal(typeof entry.response.redirectURL, 'string');
    assert.ok(entry.response.content, 'response.content is required');
    assert.equal(typeof entry.response.content.size, 'number');
    assert.equal(typeof entry.response.content.mimeType, 'string');
    assert.ok(entry.cache !== undefined, 'cache is required, even if empty');

    for (const phase of ['send', 'wait', 'receive']) {
      assert.equal(typeof entry.timings[phase], 'number', `timings.${phase} is required`);
    }

    // The spec ties these together, and DevTools renders the waterfall from it.
    assert.equal(
      entry.time,
      totalTime(entry.timings),
      'time must equal the sum of the non-negative timings',
    );
  }
}

test('produces a structurally valid HAR', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  rec.markConnected(record, '93.184.216.34');
  rec.setResponse(record, {
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=xyz; Path=/; HttpOnly' },
  });
  rec.appendResponseBody(record, Buffer.from('{"ok":true}'));
  rec.finish(record, { state: 'complete' });

  const har = toHar(rec.list());
  assertValidHar(har);
  assert.equal(har.log.entries.length, 1);

  const [entry] = har.log.entries;
  assert.equal(entry.request.url, 'http://example.com/api/thing?page=2&q=hi');
  assert.equal(entry.response.status, 200);
  assert.equal(entry.response.content.text, '{"ok":true}');
  assert.equal(entry.serverIPAddress, '93.184.216.34');
});

test('parses the query string out of the URL', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.deepEqual(entry.request.queryString, [
    { name: 'page', value: '2' },
    { name: 'q', value: 'hi' },
  ]);
});

test('parses request and response cookies', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  rec.setResponse(record, {
    statusCode: 200,
    headers: { 'Set-Cookie': 'session=xyz; Path=/; Domain=example.com; HttpOnly; Secure' },
  });
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.deepEqual(entry.request.cookies, [
    { name: 'sid', value: 'abc' },
    { name: 'theme', value: 'dark' },
  ]);
  assert.deepEqual(entry.response.cookies, [
    { name: 'session', value: 'xyz', path: '/', domain: 'example.com', httpOnly: true, secure: true },
  ]);
});

test('decompresses bodies and reports the bytes saved', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  // Long enough that gzip actually saves bytes; a short string inflates.
  const plain = JSON.stringify({ message: 'hello world '.repeat(40) });
  const gzipped = zlib.gzipSync(Buffer.from(plain));

  rec.setResponse(record, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
  });
  rec.appendResponseBody(record, gzipped);
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.equal(entry.response.content.text, plain);
  assert.equal(entry.response.content.size, plain.length);
  assert.equal(entry.response.bodySize, gzipped.length, 'bodySize is what crossed the wire');
  assert.equal(entry.response.content.compression, plain.length - gzipped.length);
  assert.ok(entry.response.content.compression > 0);
});

test('omits compression when the coding did not actually save anything', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  // Too short to compress: gzip's framing costs more than it saves, and
  // "negative bytes saved" is not a thing the format models.
  const plain = '{"a":1}';
  rec.setResponse(record, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
  });
  rec.appendResponseBody(record, zlib.gzipSync(Buffer.from(plain)));
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.equal(entry.response.content.text, plain);
  assert.equal(entry.response.content.compression, undefined);
});

test('base64-encodes binary bodies', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);

  rec.setResponse(record, { statusCode: 200, headers: { 'Content-Type': 'image/png' } });
  rec.appendResponseBody(record, png);
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.equal(entry.response.content.encoding, 'base64');
  assert.equal(Buffer.from(entry.response.content.text, 'base64').equals(png), true);
});

test('carries request bodies as postData', () => {
  const rec = recorder();
  const record = httpRecord(rec, {
    method: 'POST',
    requestHeaders: { 'Content-Type': 'application/json' },
  });
  rec.appendRequestBody(record, Buffer.from('{"a":1}'));
  rec.setResponse(record, { statusCode: 201, headers: {} });
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.equal(entry.request.postData.text, '{"a":1}');
  assert.equal(entry.request.postData.mimeType, 'application/json');
  assert.ok(Array.isArray(entry.request.postData.params));
});

test('records a refusal as blocked time, with the reason in a comment', () => {
  const rec = recorder();
  const record = httpRecord(rec, { host: 'ads.tracking.test' });
  rec.finish(record, {
    state: 'blocked',
    statusCode: 403,
    blockedReason: 'ads.tracking.test matches a deny rule',
  });

  const har = toHar(rec.list());
  assertValidHar(har);

  const [entry] = har.log.entries;
  assert.equal(entry.response.status, 403);
  assert.equal(entry.timings.connect, -1, 'nothing ever connected');
  assert.ok(entry.timings.blocked >= 0, 'the whole request was blocking');
  assert.match(entry.comment, /Refused by the proxy: ads\.tracking\.test matches a deny rule/);
});

test('exports tunnels with an explanation instead of a silently empty body', () => {
  const rec = recorder();
  const record = rec.begin({ kind: 'connect', method: 'CONNECT', host: 'api.github.com', port: 443 });
  rec.markConnected(record, '140.82.121.6');
  rec.setResponse(record, { statusCode: 200, statusMessage: 'Connection Established', headers: {} });
  rec.finish(record, { state: 'complete', bytesUp: 1200, bytesDown: 3400 });

  const har = toHar(rec.list());
  assertValidHar(har);

  const [entry] = har.log.entries;
  assert.equal(entry.request.url, 'https://api.github.com:443');
  assert.equal(entry.request.method, 'CONNECT');
  assert.equal(entry.response.bodySize, 3400);
  assert.match(entry.response.content.comment, /TLS-encrypted/);
  assert.match(entry.comment, /TLS-encrypted/);
});

test('can leave tunnels out', () => {
  const rec = recorder();
  const tunnel = rec.begin({ kind: 'connect', method: 'CONNECT', host: 'a.test', port: 443 });
  rec.finish(tunnel, { state: 'complete' });
  const plain = httpRecord(rec);
  rec.finish(plain, { state: 'complete' });

  assert.equal(toHar(rec.list()).log.entries.length, 2);
  assert.equal(toHar(rec.list(), { includeTunnels: false }).log.entries.length, 1);
});

test('skips transactions still in flight', () => {
  const rec = recorder();
  const pending = httpRecord(rec);
  rec.markConnected(pending, '1.2.3.4');
  const done = httpRecord(rec);
  rec.finish(done, { state: 'complete' });

  const har = toHar(rec.list());
  assert.equal(har.log.entries.length, 1, 'a half-written entry would be worse than none');
  assert.equal(pending.timings.completedAt, null);
});

test('expands repeated headers into separate entries', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  rec.setResponse(record, {
    statusCode: 200,
    headers: { 'Set-Cookie': ['a=1', 'b=2'], 'Content-Type': 'text/plain' },
  });
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  const setCookies = entry.response.headers.filter((h) => h.name === 'Set-Cookie');
  assert.deepEqual(setCookies, [
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'Set-Cookie', value: 'b=2' },
  ]);
});

test('notes when a body was truncated rather than pretending it is complete', () => {
  const rec = new TrafficRecorder({ enabled: true, maxBodyBytes: 4 });
  const record = httpRecord(rec);
  rec.setResponse(record, { statusCode: 200, headers: { 'Content-Type': 'text/plain' } });
  rec.appendResponseBody(record, Buffer.from('abcdefghij'));
  rec.finish(record, { state: 'complete' });

  const [entry] = toHar(rec.list()).log.entries;
  assert.equal(entry.response.content.text, 'abcd');
  assert.match(entry.response.content.comment, /truncated/i);
});

test('timings always sum to the reported total', () => {
  const cases = [
    { timings: { startedAt: 1000, connectedAt: 1010, firstByteAt: 1050, completedAt: 1100 } },
    { timings: { startedAt: 1000, connectedAt: null, firstByteAt: null, completedAt: 1005 } },
    { timings: { startedAt: 1000, connectedAt: 1010, firstByteAt: null, completedAt: 1020 } },
  ];
  for (const record of cases) {
    const timings = harTimings(record);
    const total = totalTime(timings);
    assert.ok(total >= 0, 'total must never be negative');
    assert.equal(
      total,
      Object.values(timings).filter((v) => v >= 0).reduce((a, b) => a + b, 0),
    );
  }
});

test('survives a JSON round trip, which is how every consumer reads it', () => {
  const rec = recorder();
  const record = httpRecord(rec);
  rec.markConnected(record, '1.2.3.4');
  rec.setResponse(record, { statusCode: 200, headers: { 'Content-Type': 'text/plain' } });
  rec.appendResponseBody(record, Buffer.from('body'));
  rec.finish(record, { state: 'complete' });

  const reparsed = JSON.parse(JSON.stringify(toHar(rec.list())));
  assertValidHar(reparsed);
  assert.equal(reparsed.log.entries[0].response.content.text, 'body');
});

test('exports real traffic captured through the proxy', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"served":true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const proxy = new ProxyServer(
    { port: 0, logLevel: 'silent', allowPrivateNetworks: true },
    { env: {} },
  );
  await proxy.start();
  proxy.recorder.setEnabled(true);

  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  const address = proxy.address();
  const target = `http://127.0.0.1:${upstream.address().port}/real`;
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: address.host, port: address.port, path: target, headers: { Host: 'x' } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end();
  });

  const har = toHar(proxy.recorder.list());
  assertValidHar(har);
  assert.equal(har.log.entries.length, 1);
  assert.match(har.log.entries[0].request.url, /\/real$/);
  assert.equal(har.log.entries[0].response.content.text, '{"served":true}');
});

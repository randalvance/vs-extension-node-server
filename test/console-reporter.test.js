'use strict';

/**
 * Tests for the CLI's console network log.
 *
 * Output is captured through the reporter's write sink with colour off and a
 * fixed width, so assertions are about content rather than terminal geometry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { ConsoleReporter, supportsColor } = require('../src/console-reporter');
const { TrafficRecorder } = require('../src/traffic-recorder');
const { ProxyServer } = require('../src/proxy');
const { parseArgs } = require('../src/cli');

function harness(detail = 'compact') {
  const lines = [];
  const recorder = new TrafficRecorder({ enabled: true });
  const reporter = new ConsoleReporter(recorder, {
    detail,
    color: false,
    width: 110,
    write: (text) => lines.push(text),
  });
  reporter.start();
  return { recorder, reporter, output: () => lines.join('') };
}

function completeRequest(recorder, overrides = {}) {
  const record = recorder.begin({
    kind: 'http',
    method: 'GET',
    url: 'http://example.com/api/thing',
    host: 'example.com',
    port: 80,
    path: '/api/thing',
    requestHeaders: { Accept: 'application/json' },
    ...overrides,
  });
  recorder.markConnected(record, '93.184.216.34');
  recorder.setResponse(record, {
    statusCode: 200,
    statusMessage: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
  recorder.appendResponseBody(record, Buffer.from('{"ok":true}'));
  recorder.finish(record, { state: 'complete' });
  return record;
}

test('prints one compact line per completed request', () => {
  const { recorder, output } = harness();
  completeRequest(recorder);

  const lines = output().trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2}\.\d{3}\s+200\s+GET\s+example\.com\/api\/thing/);
  assert.match(lines[0], /application\/json/);
  assert.match(lines[0], /11 B/);
});

test('prints nothing until the transaction finishes', () => {
  const { recorder, output } = harness();
  const record = recorder.begin({ kind: 'http', method: 'GET', host: 'example.com', path: '/' });
  recorder.markConnected(record, '1.2.3.4');
  recorder.setResponse(record, { statusCode: 200, headers: {} });

  assert.equal(output(), '', 'an in-flight request has no size or duration yet');

  recorder.finish(record, { state: 'complete' });
  assert.match(output(), /200/);
});

test('never prints the same transaction twice', () => {
  const { recorder, output } = harness();
  const record = completeRequest(recorder);

  // A late update — a trailing byte count, say — must not reprint the line.
  recorder.finish(record, { state: 'complete' });
  recorder.emit('update', record);

  assert.equal(output().trimEnd().split('\n').length, 1);
});

test('shows the reason a request was refused', () => {
  const { recorder, output } = harness();
  const record = recorder.begin({
    kind: 'http',
    method: 'GET',
    host: 'ads.tracking.test',
    path: '/collect',
  });
  recorder.finish(record, {
    state: 'blocked',
    statusCode: 403,
    blockedReason: 'ads.tracking.test matches a deny rule ("*.tracking.test")',
  });

  const text = output();
  assert.match(text, /403/);
  assert.match(text, /↳ ads\.tracking\.test matches a deny rule/);
});

test('shows an upstream failure message', () => {
  const { recorder, output } = harness();
  const record = recorder.begin({ kind: 'http', method: 'GET', host: 'example.com', path: '/' });
  recorder.finish(record, { state: 'error', statusCode: 502, error: 'connect ECONNREFUSED' });

  assert.match(output(), /502/);
  assert.match(output(), /↳ connect ECONNREFUSED/);
});

test('announces a tunnel when it opens and again when it closes', () => {
  const { recorder, output } = harness();
  const record = recorder.begin({
    kind: 'connect',
    method: 'CONNECT',
    host: 'api.github.com',
    port: 443,
  });

  recorder.markConnected(record, '140.82.121.6');
  recorder.setResponse(record, { statusCode: 200, statusMessage: 'Connection Established', headers: {} });

  const afterOpen = output();
  assert.match(afterOpen, /api\.github\.com:443 opened/);
  assert.equal(afterOpen.trimEnd().split('\n').length, 1, 'opening prints exactly one line');

  recorder.finish(record, { state: 'complete', bytesUp: 1200, bytesDown: 3400 });

  const lines = output().trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /api\.github\.com:443 closed/);
  assert.match(lines[1], /4\.5 kB/, 'the close line totals both directions');
});

test('a tunnel refused before it opens prints once', () => {
  const { recorder, output } = harness();
  const record = recorder.begin({
    kind: 'connect',
    method: 'CONNECT',
    host: '192.168.1.1',
    port: 443,
  });
  recorder.finish(record, {
    state: 'blocked',
    statusCode: 403,
    blockedReason: '192.168.1.1 is a private address.',
  });

  const lines = output().trimEnd().split('\n');
  assert.equal(lines.length, 2, 'the status line plus its reason');
  assert.ok(!lines[0].includes('opened'));
  assert.match(lines[0], /403/);
});

test('headers detail lists request and response headers', () => {
  const { recorder, output } = harness('headers');
  completeRequest(recorder);

  const text = output();
  assert.match(text, /request headers/);
  assert.match(text, /Accept: application\/json/);
  assert.match(text, /response headers/);
  assert.match(text, /Content-Type: application\/json/);
  assert.ok(!text.includes('"ok"'), 'headers detail must not print bodies');
});

test('bodies detail decodes and prints the body', () => {
  const { recorder, output } = harness('bodies');
  const record = recorder.begin({ kind: 'http', method: 'GET', host: 'example.com', path: '/data' });
  recorder.setResponse(record, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
  });
  recorder.appendResponseBody(record, zlib.gzipSync(Buffer.from('{"a":[1,2]}')));
  recorder.finish(record, { state: 'complete' });

  const text = output();
  assert.match(text, /response body/);
  assert.match(text, /decompressed from gzip/);
  assert.match(text, /"a": \[/, 'JSON is pretty-printed');
});

test('a tunnel prints no headers or bodies even at the deepest detail', () => {
  const { recorder, output } = harness('bodies');
  const record = recorder.begin({
    kind: 'connect',
    method: 'CONNECT',
    host: 'api.github.com',
    port: 443,
    requestHeaders: { Host: 'api.github.com:443' },
  });
  recorder.setResponse(record, { statusCode: 200, headers: {} });
  recorder.finish(record, { state: 'complete', bytesUp: 10, bytesDown: 20 });

  const text = output();
  assert.ok(!text.includes('request headers'), 'there is nothing readable inside a tunnel');
  assert.ok(!text.includes('response body'));
});

test('emits no ANSI escapes when colour is off', () => {
  const { recorder, output } = harness();
  completeRequest(recorder);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\x1b\[/.test(output()), 'plain output must be free of escape codes');
});

test('emits ANSI escapes when colour is on', () => {
  const lines = [];
  const recorder = new TrafficRecorder({ enabled: true });
  const reporter = new ConsoleReporter(recorder, {
    color: true,
    width: 110,
    write: (text) => lines.push(text),
  });
  reporter.start();
  completeRequest(recorder);

  // eslint-disable-next-line no-control-regex
  assert.ok(/\x1b\[32m200/.test(lines.join('')), '2xx should be green');
});

test('respects NO_COLOR and a non-TTY stream', () => {
  assert.equal(supportsColor({ NO_COLOR: '1' }, { isTTY: true }), false);
  assert.equal(supportsColor({}, { isTTY: false }), false);
  assert.equal(supportsColor({}, { isTTY: true }), true);
  assert.equal(supportsColor({ FORCE_COLOR: '1' }, { isTTY: false }), true);
});

test('stops printing once detached', () => {
  const { recorder, reporter, output } = harness();
  reporter.stop();
  completeRequest(recorder);
  assert.equal(output(), '');
});

test('summarises the session', () => {
  const { reporter } = harness();
  const summary = reporter.formatSummary({
    requests: 12,
    tunnels: 3,
    denied: 1,
    failed: 2,
    bytesToClient: 1024,
    bytesFromClient: 1024,
  });

  assert.match(summary, /12 requests/);
  assert.match(summary, /3 tunnels/);
  assert.match(summary, /2\.0 kB transferred/);

  const quiet = reporter.formatSummary({
    requests: 1,
    tunnels: 1,
    denied: 0,
    failed: 0,
    bytesToClient: 0,
    bytesFromClient: 0,
  });
  assert.match(quiet, /1 request · 1 tunnel/, 'counts of one are singular');
  assert.match(quiet, /0 B transferred/, 'an idle session reads as zero, not a dash');
});

// ------------------------------------------------------------- CLI plumbing

test('parses the --inspect flag in all its forms', () => {
  assert.equal(parseArgs(['--inspect']).options.inspect, 'headers', 'bare --inspect adds detail');
  assert.equal(parseArgs(['--inspect', 'bodies']).options.inspect, 'bodies');
  assert.equal(parseArgs(['--inspect', 'compact']).options.inspect, 'compact');
  assert.equal(parseArgs(['--inspect=headers']).options.inspect, 'headers');
  assert.equal(parseArgs(['--no-inspect']).options.inspect, false);
  assert.equal(parseArgs(['--no-color']).options.color, false);
  assert.throws(() => parseArgs(['--inspect=loud']), /must be one of/);
});

test('a bare --inspect does not swallow the next flag', () => {
  const { options } = parseArgs(['--inspect', '--port', '9000']);
  assert.equal(options.inspect, 'headers');
  assert.equal(options.port, '9000');
});

// -------------------------------------------------------------- end to end

test('reports real traffic driven through the proxy', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const proxy = new ProxyServer(
    { port: 0, logLevel: 'silent', allowPrivateNetworks: true, logTraffic: false },
    { env: {} },
  );
  await proxy.start();

  const lines = [];
  const reporter = new ConsoleReporter(proxy.recorder, {
    color: false,
    width: 110,
    write: (text) => lines.push(text),
  });
  proxy.recorder.setEnabled(true);
  reporter.start();

  t.after(async () => {
    reporter.stop();
    await proxy.stop();
    upstream.close();
  });

  const address = proxy.address();
  const target = `http://127.0.0.1:${upstream.address().port}/greet`;
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

  const text = lines.join('');
  assert.match(text, /200/);
  assert.match(text, /\/greet/);
  assert.match(text, /5 B/);
});

test('the proxy stays silent about traffic when logTraffic is off', async (t) => {
  const upstream = http.createServer((req, res) => res.end('x'));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const logged = [];
  const proxy = new ProxyServer(
    { port: 0, logLevel: 'debug', allowPrivateNetworks: true, logTraffic: false },
    { env: {}, logSink: (line) => logged.push(line) },
  );
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  const address = proxy.address();
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        path: `http://127.0.0.1:${upstream.address().port}/quiet`,
        headers: { Host: 'x' },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end();
  });

  assert.ok(
    !logged.some((line) => line.includes('/quiet')),
    `no per-request line expected, got: ${logged.join(' | ')}`,
  );
  assert.ok(logged.some((line) => line.includes('Proxy listening')), 'lifecycle logs still appear');
});

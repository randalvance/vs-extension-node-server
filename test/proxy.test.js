'use strict';

/**
 * End-to-end tests: a real proxy in front of real upstream servers on loopback.
 *
 * Loopback destinations are blocked by default, so these tests set
 * `allowPrivateNetworks` — except the ones that assert the block itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { ProxyServer } = require('../src/proxy');

const silent = { logLevel: 'silent' };

/** Start an HTTP origin server that echoes back what it received. */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** Start a TCP server that echoes every byte back, for CONNECT tunnel tests. */
async function startEchoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function startProxy(overrides = {}) {
  const proxy = new ProxyServer({ port: 0, ...silent, ...overrides }, { env: {} });
  await proxy.start();
  return proxy;
}

/** Issue a request through the proxy using absolute-form request-target. */
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
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Open a CONNECT tunnel and return the raw socket once established. */
function openTunnel(proxy, authority, headers = {}) {
  return new Promise((resolve, reject) => {
    const address = proxy.address();
    const req = http.request({
      host: address.host,
      port: address.port,
      method: 'CONNECT',
      path: authority,
      headers,
    });
    // Node treats every response to CONNECT as an upgrade, including refusals,
    // so a rejection arrives here too — with its body sitting in `head`.
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ res, socket: null, body: head.toString() });
        return;
      }
      resolve({ res, socket, head });
    });
    req.on('error', reject);
    req.end();
  });
}

test('forwards plain HTTP requests to the upstream', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    upstream.server.close();
  });

  const response = await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.port}/hello?a=1`);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-upstream'], 'yes');
  const payload = JSON.parse(response.body);
  assert.equal(payload.url, '/hello?a=1');
  assert.equal(payload.host, `127.0.0.1:${upstream.port}`);
  assert.equal(proxy.snapshot().requests, 1);
});

test('forwards to a hostname, pinning the address DNS returned', async (t) => {
  // Distinct from the IP-literal cases above: a name exercises the custom
  // `lookup` that pins the approved address. Node's autoSelectFamily calls it
  // with `all: true` and expects an array, so this covers that contract.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('reached via hostname');
  });
  // Bind every interface so either resolution of "localhost" (127.0.0.1 or ::1) lands.
  await new Promise((resolve) => upstream.listen(0, resolve));

  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  const response = await requestThroughProxy(
    proxy,
    `http://localhost:${upstream.address().port}/`,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'reached via hostname');
});

test('forwards request bodies', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    upstream.server.close();
  });

  const response = await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.port}/submit`, {
    method: 'POST',
    body: 'payload=42',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  assert.equal(JSON.parse(response.body).body, 'payload=42');
  assert.equal(JSON.parse(response.body).method, 'POST');
});

test('adds itself to the Via chain and strips Proxy-Authorization', async (t) => {
  const received = {};
  const upstream = http.createServer((req, res) => {
    Object.assign(received, req.headers);
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    upstream.close();
  });

  await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.address().port}/`, {
    headers: { 'Proxy-Authorization': 'Basic leak', 'X-Keep': 'kept' },
  });

  assert.match(received.via, /gitpod-egress-proxy/);
  assert.equal(received['proxy-authorization'], undefined);
  assert.equal(received['x-keep'], 'kept');
});

test('tunnels arbitrary TCP through CONNECT', async (t) => {
  const echo = await startEchoServer();
  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(async () => {
    await proxy.stop();
    echo.server.close();
  });

  const { res, socket } = await openTunnel(proxy, `127.0.0.1:${echo.port}`);
  assert.equal(res.statusCode, 200);

  const roundTripped = await new Promise((resolve) => {
    socket.on('data', (chunk) => resolve(chunk.toString()));
    socket.write('ping through the tunnel');
  });

  assert.equal(roundTripped, 'ping through the tunnel');
  socket.destroy();
  assert.equal(proxy.snapshot().tunnels, 1);
});

test('blocks loopback and private destinations by default', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy();
  t.after(async () => {
    await proxy.stop();
    upstream.server.close();
  });

  const response = await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.port}/`);
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /loopback address/);

  const tunnel = await openTunnel(proxy, '10.0.0.1:443');
  assert.equal(tunnel.res.statusCode, 403);
  assert.equal(tunnel.socket, null);
  assert.equal(proxy.snapshot().denied, 2);
});

test('requires credentials when configured, for both requests and tunnels', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    allowPrivateNetworks: true,
    username: 'gitpod',
    password: 'correct horse',
  });
  t.after(async () => {
    await proxy.stop();
    upstream.server.close();
  });

  const target = `http://127.0.0.1:${upstream.port}/`;

  const anonymous = await requestThroughProxy(proxy, target);
  assert.equal(anonymous.statusCode, 407);
  assert.match(anonymous.headers['proxy-authenticate'], /^Basic/);

  const wrong = await requestThroughProxy(proxy, target, {
    headers: { 'Proxy-Authorization': `Basic ${Buffer.from('gitpod:nope').toString('base64')}` },
  });
  assert.equal(wrong.statusCode, 407);

  const correct = await requestThroughProxy(proxy, target, {
    headers: {
      'Proxy-Authorization': `Basic ${Buffer.from('gitpod:correct horse').toString('base64')}`,
    },
  });
  assert.equal(correct.statusCode, 200);

  const anonymousTunnel = await openTunnel(proxy, '127.0.0.1:443');
  assert.equal(anonymousTunnel.res.statusCode, 407);
});

test('enforces deny and allow lists', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    allowPrivateNetworks: true,
    denyHosts: ['*.blocked.test'],
    allowHosts: ['127.0.0.1', '*.allowed.test'],
  });
  t.after(async () => {
    await proxy.stop();
    upstream.server.close();
  });

  const denied = await requestThroughProxy(proxy, 'http://api.blocked.test/');
  assert.equal(denied.statusCode, 403);
  assert.match(denied.body, /deny rule/);

  const notListed = await requestThroughProxy(proxy, 'http://elsewhere.test/');
  assert.equal(notListed.statusCode, 403);
  assert.match(notListed.body, /allowlist/);

  const permitted = await requestThroughProxy(proxy, `http://127.0.0.1:${upstream.port}/`);
  assert.equal(permitted.statusCode, 200);
});

test('enforces the port allowlist', async (t) => {
  const proxy = await startProxy({ allowPrivateNetworks: true, allowPorts: [443] });
  t.after(() => proxy.stop());

  const tunnel = await openTunnel(proxy, '127.0.0.1:22');
  assert.equal(tunnel.res.statusCode, 403);
  assert.match(tunnel.body, /port allowlist/i);
});

test('reports a helpful error instead of hanging when the upstream is unreachable', async (t) => {
  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(() => proxy.stop());

  // Port 1 on loopback has nothing listening, so the connection is refused.
  const response = await requestThroughProxy(proxy, 'http://127.0.0.1:1/');
  assert.equal(response.statusCode, 502);
  assert.match(response.body, /ECONNREFUSED/);
  assert.equal(proxy.snapshot().failed, 1);
});

test('serves its own health, PAC, and help endpoints', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.stop());

  const address = proxy.address();
  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: address.host, port: address.port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  const health = await get('/healthz');
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');

  const pac = await get('/proxy.pac');
  assert.equal(pac.statusCode, 200);
  assert.match(pac.body, /function FindProxyForURL/);
  assert.match(pac.body, new RegExp(`PROXY .*:${address.port}`));

  const stats = await get('/stats');
  assert.equal(stats.statusCode, 200);
  assert.equal(typeof JSON.parse(stats.body).requests, 'number');

  const help = await get('/');
  assert.equal(help.statusCode, 400);
  assert.match(help.body, /forward proxy/);
});

test('keeps /stats behind credentials but leaves /healthz open', async (t) => {
  const proxy = await startProxy({ username: 'u', password: 'password1' });
  t.after(() => proxy.stop());

  const address = proxy.address();
  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: address.host, port: address.port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });

  assert.equal(await get('/healthz'), 200);
  assert.equal(await get('/stats'), 407);
});

test('rejects absolute URIs it cannot forward', async (t) => {
  const proxy = await startProxy({ allowPrivateNetworks: true });
  t.after(() => proxy.stop());

  const response = await requestThroughProxy(proxy, 'ftp://example.com/file');
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /Only http:\/\//);
});

test('stops cleanly and releases the port', async () => {
  const proxy = await startProxy({ allowPrivateNetworks: true });
  const { port } = proxy.address();
  await proxy.stop();
  assert.equal(proxy.listening, false);

  const rebound = new ProxyServer({ port, host: '127.0.0.1', ...silent }, { env: {} });
  await rebound.start();
  assert.equal(rebound.address().port, port);
  await rebound.stop();
});

test('surfaces a readable message when the port is taken', async (t) => {
  const first = await startProxy();
  const { port } = first.address();
  t.after(() => first.stop());

  const second = new ProxyServer({ port, host: '127.0.0.1', ...silent }, { env: {} });
  await assert.rejects(() => second.start(), /already in use/);
});

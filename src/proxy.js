'use strict';

/**
 * A dependency-free HTTP forward proxy.
 *
 * Speaks the three things an `HTTP_PROXY`/`HTTPS_PROXY` client needs:
 *   - absolute-URI requests (`GET http://host/path`) for plain HTTP,
 *   - `CONNECT host:443` tunnels for HTTPS and anything else over TLS,
 *   - `Upgrade` for WebSockets carried over plain HTTP.
 *
 * It knows nothing about VS Code or the CLI; both entry points drive this
 * class. Requires only Node core modules so it can run on the bundled Node
 * inside the VS Code extension host, where `npm install` is not an option.
 */

const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const { resolveConfig } = require('./config');
const { createLogger } = require('./logger');
const { createAccessController, AccessError } = require('./access');
const { forwardableHeaders, allHeaders, appendVia } = require('./headers');
const { TrafficRecorder } = require('./traffic-recorder');

const PROXY_AGENT = 'gitpod-egress-proxy';

class ProxyServer extends EventEmitter {
  constructor(overrides = {}, deps = {}) {
    super();
    this.config = resolveConfig(overrides, deps.env || process.env);
    this.logger =
      deps.logger || createLogger({ level: this.config.logLevel, sink: deps.logSink });
    this.access = createAccessController(this.config, this.logger);
    // Idle unless a UI turns it on, so the CLI pays nothing for it.
    this.recorder = deps.recorder || new TrafficRecorder();

    this.stats = {
      startedAt: null,
      requests: 0,
      tunnels: 0,
      upgrades: 0,
      denied: 0,
      failed: 0,
      activeConnections: 0,
      bytesToClient: 0,
      bytesFromClient: 0,
    };

    this._sockets = new Set();
    this._starting = false;
    this._server = this._createServer();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Bind the listener. Resolves with `{ host, port }` once accepting. */
  start() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this._starting = false;
        this._server.removeListener('listening', onListening);
        reject(this._describeBindError(error));
      };
      const onListening = () => {
        this._starting = false;
        this._server.removeListener('error', onError);
        this.stats.startedAt = new Date();
        const address = this.address();
        this.logger.info(`Proxy listening on ${address.host}:${address.port}`);
        if (!this.config.authEnabled) {
          this.logger.warn('No credentials configured — anything that can reach this port can use it.');
        }
        if (!this.config.allowPrivateNetworks) {
          this.logger.info('Private and loopback destinations are blocked.');
        } else {
          this.logger.warn('Private network access is ENABLED — clients can reach your LAN.');
        }
        this.emit('listening', address);
        resolve(address);
      };

      this._starting = true;
      this._server.once('error', onError);
      this._server.once('listening', onListening);
      this._server.listen(this.config.port, this.config.host);
    });
  }

  /** Close the listener and destroy live connections. */
  stop() {
    return new Promise((resolve) => {
      if (!this._server.listening) {
        resolve();
        return;
      }
      this._server.close(() => {
        this.logger.info('Proxy stopped');
        this.emit('stopped');
        resolve();
      });
      for (const socket of this._sockets) socket.destroy();
      this._sockets.clear();
    });
  }

  get listening() {
    return this._server.listening;
  }

  /** The bound address, or null when not listening. */
  address() {
    const info = this._server.address();
    if (!info) return null;
    return { host: info.address, port: info.port, family: info.family };
  }

  /** A snapshot of counters, plus derived uptime. */
  snapshot() {
    return {
      ...this.stats,
      listening: this.listening,
      address: this.address(),
      uptimeMs: this.stats.startedAt ? Date.now() - this.stats.startedAt.getTime() : 0,
    };
  }

  // ------------------------------------------------------------------ wiring

  _createServer() {
    const server = http.createServer();
    server.maxConnections = this.config.maxConnections;

    server.on('connection', (socket) => {
      this._sockets.add(socket);
      this.stats.activeConnections += 1;
      socket.once('close', () => {
        this._sockets.delete(socket);
        this.stats.activeConnections -= 1;
      });
    });

    server.on('request', (req, res) => {
      this._handleRequest(req, res).catch((error) => {
        this.logger.error(`Unhandled request failure: ${error.stack || error.message}`);
        this._failRequest(res, 500, 'Proxy internal error');
      });
    });

    server.on('connect', (req, socket, head) => {
      this._handleConnect(req, socket, head).catch((error) => {
        this.logger.error(`Unhandled CONNECT failure: ${error.stack || error.message}`);
        socket.destroy();
      });
    });

    server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head).catch((error) => {
        this.logger.error(`Unhandled upgrade failure: ${error.stack || error.message}`);
        socket.destroy();
      });
    });

    server.on('clientError', (error, socket) => {
      this.logger.debug(`Client error: ${error.message}`);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    server.on('error', (error) => {
      // While starting, start()'s own handler owns the error: it wraps bind
      // failures in something actionable and rejects the promise. Re-emitting
      // here would either double-report it or, with no 'error' listener
      // attached, throw out of emit() before that handler ever runs.
      if (this._starting) return;
      this.logger.error(`Server error: ${error.message}`);
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });

    return server;
  }

  // --------------------------------------------------------- plain HTTP path

  async _handleRequest(req, res) {
    // Origin-form means the request is addressed to the proxy itself rather
    // than through it: the status and PAC endpoints live here.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(req.url)) {
      this._handleIntrospection(req, res);
      return;
    }

    let target;
    try {
      target = new URL(req.url);
    } catch {
      this._failRequest(res, 400, `Malformed absolute URI: ${req.url}`);
      return;
    }

    const port = Number(target.port) || 80;

    // Opened before the policy gates so refusals show up in the inspector too:
    // seeing what the workspace tried to reach, and why it was turned away, is
    // usually the reason someone opens it.
    const record = this.recorder.begin({
      kind: 'http',
      method: req.method,
      url: req.url,
      scheme: target.protocol.replace(':', ''),
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      clientAddress: req.socket.remoteAddress,
      httpVersion: req.httpVersion,
      requestHeaders: allHeaders(req.rawHeaders),
    });

    if (!this.access.checkCredentials(req.headers['proxy-authorization'])) {
      this.stats.denied += 1;
      this._logTraffic('warn', `407 ${req.method} ${req.url} — missing or invalid credentials`);
      this.recorder.finish(record, {
        state: 'blocked',
        statusCode: 407,
        blockedReason: 'Missing or invalid proxy credentials',
      });
      res.writeHead(407, {
        'Proxy-Authenticate': `Basic realm="${PROXY_AGENT}"`,
        'Content-Type': 'text/plain; charset=utf-8',
        Connection: 'close',
      });
      res.end('Proxy authentication required\n');
      return;
    }

    if (target.protocol !== 'http:') {
      const message = `Only http:// absolute URIs are forwardable; use CONNECT for ${target.protocol}//`;
      this.recorder.finish(record, { state: 'blocked', statusCode: 400, blockedReason: message });
      this._failRequest(res, 400, message);
      return;
    }

    let destination;
    try {
      destination = await this.access.resolveDestination(target.hostname, port);
    } catch (error) {
      this._rejectByPolicy(error, `${req.method} ${req.url}`, (status, message) => {
        this.recorder.finish(record, {
          state: 'blocked',
          statusCode: status,
          blockedReason: message,
        });
        this._failRequest(res, status, message);
      });
      return;
    }

    this.stats.requests += 1;
    const headers = appendVia(forwardableHeaders(req.rawHeaders), `1.${req.httpVersionMinor}`, PROXY_AGENT);

    const upstream = http.request({
      host: target.hostname,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      lookup: pinnedLookup(destination),
      timeout: this.config.connectTimeoutMs,
    });

    upstream.on('socket', (socket) => {
      socket.setTimeout(this.config.socketTimeoutMs);
      if (socket.connecting) {
        socket.once('connect', () => this.recorder.markConnected(record, destination.address));
      } else {
        // A pooled socket is already connected, so there is no event coming.
        this.recorder.markConnected(record, destination.address);
      }
      socket.once('close', () => {
        this.stats.bytesToClient += socket.bytesRead;
        this.stats.bytesFromClient += socket.bytesWritten;
      });
    });

    upstream.on('timeout', () => {
      upstream.destroy(new Error('Upstream timed out'));
    });

    let completed = false;
    upstream.on('response', (upstreamRes) => {
      this._logTraffic('info', `${upstreamRes.statusCode} ${req.method} ${req.url}`);
      this.recorder.setResponse(record, {
        statusCode: upstreamRes.statusCode,
        statusMessage: upstreamRes.statusMessage,
        headers: allHeaders(upstreamRes.rawHeaders),
      });

      res.writeHead(upstreamRes.statusCode, forwardableHeaders(upstreamRes.rawHeaders));
      upstreamRes.pipe(res);
      // Same tick as the pipe, so the tee cannot miss a chunk.
      if (record) {
        upstreamRes.on('data', (chunk) => this.recorder.appendResponseBody(record, chunk));
      }
      upstreamRes.on('end', () => {
        completed = true;
        this.recorder.finish(record, { state: 'complete' });
      });
      upstreamRes.on('error', (error) => {
        this.recorder.finish(record, { state: 'error', error: error.message });
        res.destroy();
      });
    });

    upstream.on('error', (error) => {
      this.stats.failed += 1;
      this._logTraffic('warn', `502 ${req.method} ${req.url} — ${error.message}`);
      this.recorder.finish(record, { state: 'error', statusCode: 502, error: error.message });
      this._failRequest(res, 502, `Upstream request failed: ${error.message}`);
    });

    req.pipe(upstream);
    if (record) req.on('data', (chunk) => this.recorder.appendRequestBody(record, chunk));
    req.on('error', () => upstream.destroy());
    // A client that hangs up mid-response should not leave the upstream
    // transfer running, but a finished exchange leaves its socket in the
    // agent's pool for the next request to reuse.
    res.on('close', () => {
      if (!completed) upstream.destroy();
    });
  }

  // ------------------------------------------------------------ CONNECT path

  async _handleConnect(req, clientSocket, head) {
    clientSocket.on('error', (error) => this.logger.debug(`Client socket error: ${error.message}`));

    const parsed = parseAuthority(req.url, 443);

    // Everything past the CONNECT line is TLS, so this record carries the
    // handshake metadata and byte counts and nothing else. The inspector says
    // as much rather than showing an empty body pane.
    const record = this.recorder.begin({
      kind: 'connect',
      method: 'CONNECT',
      url: req.url,
      scheme: 'https',
      host: parsed ? parsed.hostname : req.url,
      port: parsed ? parsed.port : null,
      path: '',
      clientAddress: clientSocket.remoteAddress,
      httpVersion: req.httpVersion,
      requestHeaders: allHeaders(req.rawHeaders),
    });

    if (!this.access.checkCredentials(req.headers['proxy-authorization'])) {
      this.stats.denied += 1;
      this._logTraffic('warn', `407 CONNECT ${req.url} — missing or invalid credentials`);
      this.recorder.finish(record, {
        state: 'blocked',
        statusCode: 407,
        blockedReason: 'Missing or invalid proxy credentials',
      });
      writeRawResponse(clientSocket, 407, 'Proxy Authentication Required', {
        'Proxy-Authenticate': `Basic realm="${PROXY_AGENT}"`,
      });
      return;
    }

    if (!parsed) {
      const message = `Malformed CONNECT target: ${req.url}`;
      this.recorder.finish(record, { state: 'blocked', statusCode: 400, blockedReason: message });
      writeRawResponse(clientSocket, 400, 'Bad Request', {}, `${message}\n`);
      return;
    }

    let destination;
    try {
      destination = await this.access.resolveDestination(parsed.hostname, parsed.port);
    } catch (error) {
      this._rejectByPolicy(error, `CONNECT ${req.url}`, (status, message) => {
        this.recorder.finish(record, {
          state: 'blocked',
          statusCode: status,
          blockedReason: message,
        });
        writeRawResponse(clientSocket, status, http.STATUS_CODES[status] || 'Error', {}, `${message}\n`);
      });
      return;
    }

    this.stats.tunnels += 1;

    const upstream = net.connect({ host: destination.address, port: parsed.port });
    let established = false;
    const connectTimer = setTimeout(() => {
      upstream.destroy(new Error(`Timed out connecting to ${req.url}`));
    }, this.config.connectTimeoutMs);

    upstream.once('connect', () => {
      clearTimeout(connectTimer);
      established = true;
      this._logTraffic('info', `200 CONNECT ${parsed.hostname}:${parsed.port} (${destination.address})`);
      this.recorder.markConnected(record, destination.address);
      this.recorder.setResponse(record, {
        statusCode: 200,
        statusMessage: 'Connection Established',
        headers: {},
      });

      upstream.setTimeout(this.config.socketTimeoutMs);
      clientSocket.setTimeout(this.config.socketTimeoutMs);
      clientSocket.setNoDelay(true);
      upstream.setNoDelay(true);

      writeRawResponse(clientSocket, 200, 'Connection Established', {}, null, { keepOpen: true });
      if (head && head.length > 0) upstream.write(head);

      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const teardown = (error) => {
      clearTimeout(connectTimer);
      if (error) {
        this.stats.failed += 1;
        this._logTraffic('warn', `CONNECT ${req.url} failed — ${error.message}`);
        // Only before the 200 goes out. Once the tunnel is established the
        // client is speaking TLS into this socket, and an HTTP error response
        // would arrive as garbage inside its handshake.
        if (!established && !clientSocket.destroyed && clientSocket.writable) {
          this.recorder.finish(record, { state: 'error', statusCode: 502, error: error.message });
          writeRawResponse(clientSocket, 502, 'Bad Gateway', {}, `${error.message}\n`);
          return;
        }
      }
      clientSocket.destroy();
    };

    upstream.on('timeout', () => upstream.destroy(new Error('Tunnel idle timeout')));
    upstream.on('error', teardown);
    upstream.once('close', () => {
      this.stats.bytesToClient += upstream.bytesRead;
      this.stats.bytesFromClient += upstream.bytesWritten;
      this.recorder.finish(record, {
        state: established ? 'complete' : 'error',
        bytesDown: upstream.bytesRead,
        bytesUp: upstream.bytesWritten,
      });
      clientSocket.destroy();
    });
    clientSocket.on('timeout', () => clientSocket.destroy());
    clientSocket.once('close', () => upstream.destroy());
  }

  // ------------------------------------------------------------ upgrade path

  async _handleUpgrade(req, clientSocket, head) {
    clientSocket.on('error', (error) => this.logger.debug(`Client socket error: ${error.message}`));

    if (!this.access.checkCredentials(req.headers['proxy-authorization'])) {
      this.stats.denied += 1;
      writeRawResponse(clientSocket, 407, 'Proxy Authentication Required', {
        'Proxy-Authenticate': `Basic realm="${PROXY_AGENT}"`,
      });
      return;
    }

    if (!/^http:\/\//i.test(req.url)) {
      writeRawResponse(clientSocket, 400, 'Bad Request', {}, 'Upgrade requires an absolute http:// URI\n');
      return;
    }

    const target = new URL(req.url);
    const port = Number(target.port) || 80;

    let destination;
    try {
      destination = await this.access.resolveDestination(target.hostname, port);
    } catch (error) {
      this._rejectByPolicy(error, `UPGRADE ${req.url}`, (status, message) =>
        writeRawResponse(clientSocket, status, http.STATUS_CODES[status] || 'Error', {}, `${message}\n`),
      );
      return;
    }

    this.stats.upgrades += 1;

    const upstream = http.request({
      host: target.hostname,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: forwardableHeaders(req.rawHeaders, { keepUpgrade: true }),
      lookup: pinnedLookup(destination),
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      this._logTraffic('info', `101 UPGRADE ${req.url}`);
      const statusLine = [`HTTP/1.1 101 ${upstreamRes.statusMessage || 'Switching Protocols'}`];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        statusLine.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      }
      clientSocket.write(`${statusLine.join('\r\n')}\r\n\r\n`);

      if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
      if (head && head.length > 0) upstreamSocket.write(head);

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);

      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => clientSocket.destroy());
      clientSocket.once('close', () => upstreamSocket.destroy());
    });

    upstream.on('response', () => {
      // The upstream declined to switch protocols; nothing useful to tunnel.
      writeRawResponse(clientSocket, 502, 'Bad Gateway', {}, 'Upstream refused the upgrade\n');
    });

    upstream.on('error', (error) => {
      this.stats.failed += 1;
      this._logTraffic('warn', `UPGRADE ${req.url} failed — ${error.message}`);
      writeRawResponse(clientSocket, 502, 'Bad Gateway', {}, `${error.message}\n`);
    });

    upstream.end();
  }

  // ------------------------------------------------------- proxy's own pages

  _handleIntrospection(req, res) {
    const path = req.url.split('?')[0];
    const address = this.address() || { host: this.config.host, port: this.config.port };

    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify({ status: 'ok', uptimeMs: this.snapshot().uptimeMs })}\n`);
      return;
    }

    if (path === '/proxy.pac') {
      const pac =
        'function FindProxyForURL(url, host) {\n' +
        '  if (isPlainHostName(host) || shExpMatch(host, "localhost") ||\n' +
        '      shExpMatch(host, "127.*") || shExpMatch(host, "*.local")) {\n' +
        '    return "DIRECT";\n' +
        '  }\n' +
        `  return "PROXY ${address.host}:${address.port}; DIRECT";\n` +
        '}\n';
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      res.end(pac);
      return;
    }

    // Everything else about the proxy's own state requires credentials, since
    // it reports traffic volumes and configuration.
    if (!this.access.checkCredentials(req.headers['proxy-authorization'])) {
      res.writeHead(407, {
        'Proxy-Authenticate': `Basic realm="${PROXY_AGENT}"`,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('Proxy authentication required\n');
      return;
    }

    if (path === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify(this.snapshot(), null, 2)}\n`);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `${PROXY_AGENT}: this is a forward proxy, not a web server.\n\n` +
        'Point a client at it instead of requesting paths directly:\n' +
        `  export HTTP_PROXY=http://${address.host}:${address.port}\n\n` +
        'Endpoints on the proxy itself: /healthz, /stats, /proxy.pac\n',
    );
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Log one transaction. Silent when something else is rendering traffic —
   * the CLI's console reporter or the VS Code inspector — so the same request
   * is not reported twice. Diagnostics elsewhere use `this.logger` directly.
   */
  _logTraffic(level, message) {
    if (!this.config.logTraffic) return;
    this.logger[level](message);
  }

  _rejectByPolicy(error, label, respond) {
    if (!(error instanceof AccessError)) throw error;
    this.stats.denied += 1;
    this._logTraffic('warn', `${error.statusCode} ${label} — ${error.message}`);
    respond(error.statusCode, error.message);
  }

  _failRequest(res, status, message) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    res.end(`${message}\n`);
  }

  _describeBindError(error) {
    if (error.code === 'EADDRINUSE') {
      return new Error(
        `Port ${this.config.port} on ${this.config.host} is already in use. ` +
          'Stop the other listener or choose a different port.',
      );
    }
    if (error.code === 'EACCES') {
      return new Error(
        `Not permitted to bind ${this.config.host}:${this.config.port}. ` +
          'Ports below 1024 need elevated privileges — pick a higher port.',
      );
    }
    if (error.code === 'EADDRNOTAVAIL') {
      return new Error(`No interface on this machine has the address ${this.config.host}.`);
    }
    return error;
  }
}

/**
 * A `lookup` implementation that always yields the address the access policy
 * already approved, so the socket cannot land somewhere else than the one that
 * was checked. Handles both callback shapes: with `autoSelectFamily` on (the
 * default since Node 20) Node passes `all: true` and expects an array.
 */
function pinnedLookup(destination) {
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(null, [{ address: destination.address, family: destination.family }]);
      return;
    }
    callback(null, destination.address, destination.family);
  };
}

/** Split `host:port` / `[v6]:port` into parts, defaulting the port. */
function parseAuthority(authority, defaultPort) {
  if (!authority) return null;

  const bracketed = authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { hostname: bracketed[1], port: Number(bracketed[2] || defaultPort) };
  }

  const lastColon = authority.lastIndexOf(':');
  if (lastColon === -1) return { hostname: authority, port: defaultPort };

  const host = authority.slice(0, lastColon);
  const port = Number(authority.slice(lastColon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: host, port };
}

/** Write a complete HTTP response directly to a hijacked socket. */
function writeRawResponse(socket, status, statusText, headers = {}, body = null, options = {}) {
  if (socket.destroyed || !socket.writable) return;

  const lines = [`HTTP/1.1 ${status} ${statusText}`, `Proxy-Agent: ${PROXY_AGENT}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);

  if (body !== null) {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  }
  if (!options.keepOpen) lines.push('Connection: close');

  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (body !== null) socket.write(body);
  if (!options.keepOpen) socket.end();
}

module.exports = { ProxyServer, parseAuthority, PROXY_AGENT };

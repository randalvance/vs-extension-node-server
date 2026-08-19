'use strict';

/**
 * An in-memory record of what passed through the proxy, for the inspector UI.
 *
 * Bounded on purpose. A proxy carrying a `npm install` sees thousands of
 * transactions, so this keeps a ring buffer of the most recent ones and caps
 * how much of any single body it holds. When recording is off — which is the
 * default, and what the CLI runs with — every method returns immediately and
 * nothing is retained.
 *
 * Knows nothing about VS Code: it emits events, and a UI layer subscribes.
 */

const { EventEmitter } = require('node:events');

const { findHeader } = require('./headers');

const DEFAULTS = {
  enabled: false,
  captureBodies: true,
  maxEntries: 500,
  maxBodyBytes: 256 * 1024,
};

class TrafficRecorder extends EventEmitter {
  constructor(options = {}) {
    super();
    const settings = { ...DEFAULTS, ...options };
    this.enabled = settings.enabled;
    this.captureBodies = settings.captureBodies;
    this.maxEntries = settings.maxEntries;
    this.maxBodyBytes = settings.maxBodyBytes;

    /** @type {Map<number, object>} */
    this._records = new Map();
    this._order = [];
    this._nextId = 1;
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.emit('state', { enabled });
  }

  configure(options = {}) {
    if (options.captureBodies !== undefined) this.captureBodies = options.captureBodies;
    if (options.maxBodyBytes !== undefined) this.maxBodyBytes = options.maxBodyBytes;
    if (options.maxEntries !== undefined) {
      this.maxEntries = options.maxEntries;
      this._evictOverflow();
    }
  }

  /**
   * Open a record. Returns null when recording is off, and every other method
   * here tolerates null, so callers can stay free of `if (recording)` branches.
   */
  begin(descriptor) {
    if (!this.enabled) return null;

    const record = {
      id: this._nextId++,
      kind: descriptor.kind,
      method: descriptor.method,
      url: descriptor.url,
      scheme: descriptor.scheme,
      host: descriptor.host,
      port: descriptor.port,
      path: descriptor.path,
      clientAddress: descriptor.clientAddress,
      state: 'pending',
      error: null,
      blockedReason: null,
      request: {
        headers: descriptor.requestHeaders || {},
        httpVersion: descriptor.httpVersion,
        chunks: [],
        bytes: 0,
        truncated: false,
      },
      response: {
        statusCode: null,
        statusMessage: null,
        headers: {},
        chunks: [],
        bytes: 0,
        truncated: false,
      },
      timings: {
        startedAt: Date.now(),
        connectedAt: null,
        firstByteAt: null,
        completedAt: null,
      },
      remoteAddress: null,
      bytesUp: 0,
      bytesDown: 0,
    };

    this._records.set(record.id, record);
    this._order.push(record.id);
    this._evictOverflow();
    this.emit('begin', record);
    return record;
  }

  appendRequestBody(record, chunk) {
    this._appendBody(record, record && record.request, chunk);
  }

  appendResponseBody(record, chunk) {
    this._appendBody(record, record && record.response, chunk);
  }

  _appendBody(record, side, chunk) {
    if (!record || !side) return;
    side.bytes += chunk.length;
    if (!this.captureBodies) return;

    const held = side.chunks.reduce((total, held) => total + held.length, 0);
    const room = this.maxBodyBytes - held;
    if (room <= 0) {
      side.truncated = true;
      return;
    }
    if (chunk.length > room) {
      side.chunks.push(Buffer.from(chunk.subarray(0, room)));
      side.truncated = true;
      return;
    }
    side.chunks.push(Buffer.from(chunk));
  }

  markConnected(record, remoteAddress) {
    if (!record) return;
    record.timings.connectedAt = Date.now();
    record.remoteAddress = remoteAddress;
    this.emit('update', record);
  }

  setResponse(record, { statusCode, statusMessage, headers }) {
    if (!record) return;
    record.timings.firstByteAt = Date.now();
    record.response.statusCode = statusCode;
    record.response.statusMessage = statusMessage;
    record.response.headers = headers || {};
    this.emit('update', record);
  }

  finish(record, patch = {}) {
    if (!record) return;
    record.timings.completedAt = Date.now();
    record.state = patch.state || 'complete';
    if (patch.error) record.error = patch.error;
    if (patch.blockedReason) record.blockedReason = patch.blockedReason;
    if (patch.statusCode !== undefined) record.response.statusCode = patch.statusCode;
    if (patch.bytesUp !== undefined) record.bytesUp = patch.bytesUp;
    if (patch.bytesDown !== undefined) record.bytesDown = patch.bytesDown;
    this.emit('update', record);
  }

  get(id) {
    return this._records.get(id) || null;
  }

  list() {
    return this._order.map((id) => this._records.get(id)).filter(Boolean);
  }

  get size() {
    return this._order.length;
  }

  clear() {
    this._records.clear();
    this._order = [];
    this.emit('cleared');
  }

  _evictOverflow() {
    while (this._order.length > this.maxEntries) {
      const evicted = this._order.shift();
      this._records.delete(evicted);
      this.emit('evict', evicted);
    }
  }
}

/**
 * The row shape the inspector list renders. Deliberately excludes bodies —
 * those are fetched only for the selected transaction, so a busy session does
 * not ship megabytes into the webview.
 */
function toSummary(record) {
  const { timings } = record;
  const end = timings.completedAt || Date.now();
  return {
    id: record.id,
    kind: record.kind,
    method: record.method,
    url: record.url,
    scheme: record.scheme,
    host: record.host,
    port: record.port,
    path: record.path,
    state: record.state,
    statusCode: record.response.statusCode,
    statusMessage: record.response.statusMessage,
    contentType: findHeader(record.response.headers, 'content-type'),
    error: record.error,
    blockedReason: record.blockedReason,
    startedAt: timings.startedAt,
    durationMs: end - timings.startedAt,
    ttfbMs: timings.firstByteAt ? timings.firstByteAt - timings.startedAt : null,
    requestBytes: record.request.bytes || record.bytesUp,
    responseBytes: record.response.bytes || record.bytesDown,
  };
}

module.exports = { TrafficRecorder, toSummary, DEFAULTS };

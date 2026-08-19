'use strict';

/**
 * The CLI's answer to the VS Code inspector: renders the same TrafficRecorder
 * stream as terminal output.
 *
 * Three levels of detail. `compact` is one aligned line per transaction — a
 * network log you can leave running. `headers` adds the request and response
 * headers underneath. `bodies` adds decoded bodies on top of that.
 *
 * Tunnels print twice: once when they open, so a long-lived HTTPS connection
 * shows up immediately rather than looking like a hung proxy, and once when it
 * closes with the byte totals.
 */

const { previewBody } = require('./body-preview');
const { findHeader } = require('./headers');

const DETAIL_LEVELS = ['compact', 'headers', 'bodies'];

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const MAX_BODY_LINES = 20;
const MAX_BODY_CHARS = 2000;

class ConsoleReporter {
  constructor(recorder, options = {}) {
    this.recorder = recorder;
    this.detail = DETAIL_LEVELS.includes(options.detail) ? options.detail : 'compact';
    this._write = options.write || ((text) => process.stdout.write(text));
    this._color = options.color !== undefined ? options.color : supportsColor();
    this._width = options.width || null;
    this._states = new Map();
    this._subscriptions = [];
  }

  /** True when this level keeps bodies, so the recorder can skip them otherwise. */
  get needsBodies() {
    return this.detail === 'bodies';
  }

  start() {
    if (this._subscriptions.length > 0) return;

    const onUpdate = (record) => this._onUpdate(record);
    const onEvict = (id) => this._states.delete(id);
    const onCleared = () => this._states.clear();

    this.recorder.on('update', onUpdate);
    this.recorder.on('evict', onEvict);
    this.recorder.on('cleared', onCleared);
    this._subscriptions.push(() => {
      this.recorder.off('update', onUpdate);
      this.recorder.off('evict', onEvict);
      this.recorder.off('cleared', onCleared);
    });
  }

  stop() {
    for (const unsubscribe of this._subscriptions) unsubscribe();
    this._subscriptions = [];
    this._states.clear();
  }

  // ------------------------------------------------------------------ events

  _onUpdate(record) {
    const state = this._states.get(record.id);

    if (record.timings.completedAt) {
      if (state === 'closed') return;
      this._states.set(record.id, 'closed');
      this._printTerminal(record, state === 'opened');
      return;
    }

    if (record.kind === 'connect' && record.response.statusCode === 200 && !state) {
      this._states.set(record.id, 'opened');
      this._writeLine(this._formatLine(record, { phase: 'open' }));
    }
  }

  _printTerminal(record, wasOpen) {
    // A tunnel that already announced itself only needs its closing totals.
    this._writeLine(this._formatLine(record, { phase: wasOpen ? 'close' : 'done' }));

    const reason = record.blockedReason || record.error;
    if (reason) this._writeLine(this._indent(this._paint(`↳ ${reason}`, ANSI.gray)));

    if (this.detail === 'compact' || record.kind === 'connect') return;

    this._printHeaders('request', record.request.headers);
    this._printHeaders('response', record.response.headers);

    if (this.detail === 'bodies') {
      this._printBody('request', record.request, record.request.headers);
      this._printBody('response', record.response, record.response.headers);
    }
  }

  // --------------------------------------------------------------- rendering

  _formatLine(record, { phase }) {
    const columns = this._columns();
    // Stamp each line with when it was printed, not when the transaction began,
    // so a tunnel that closes minutes later still reads in order.
    const time = formatClock(
      phase === 'close' ? record.timings.completedAt : record.timings.startedAt,
    );
    const status = this._statusCell(record, phase);
    const method = (record.method || '').padEnd(7).slice(0, 7);

    const sizeText = phase === 'open' ? '' : formatBytes(totalBytes(record));
    const durationText =
      phase === 'open' ? '' : formatDuration(record.timings.completedAt - record.timings.startedAt);

    // Everything but the target is fixed width, so the target absorbs the rest.
    const fixed = 12 + 1 + 3 + 1 + 7 + 1 + 9 + 1 + 8;
    const targetWidth = Math.max(20, columns - fixed);
    const target = truncate(describeTarget(record, phase), targetWidth).padEnd(targetWidth);

    const line =
      `${this._paint(time, ANSI.gray)} ${status} ${this._paint(method, ANSI.bold)} ` +
      `${target} ${sizeText.padStart(9)} ${durationText.padStart(8)}`;

    return phase === 'close'
      ? this._paint(stripAnsi(line).trimEnd(), ANSI.dim)
      : line.trimEnd();
  }

  _statusCell(record, phase) {
    if (phase === 'open') return this._paint('···', ANSI.magenta);

    const code = record.response.statusCode;
    const text = code ? String(code) : record.state === 'blocked' ? '---' : 'ERR';

    if (record.state === 'blocked') return this._paint(text, ANSI.yellow);
    if (record.state === 'error') return this._paint(text, ANSI.red);
    if (record.kind === 'connect') return this._paint(text, ANSI.magenta);
    if (code >= 500) return this._paint(text, ANSI.red);
    if (code >= 400) return this._paint(text, ANSI.yellow);
    if (code >= 300) return this._paint(text, ANSI.cyan);
    return this._paint(text, ANSI.green);
  }

  _printHeaders(label, headers) {
    const entries = Object.entries(headers || {});
    if (entries.length === 0) return;

    this._writeLine(this._indent(this._paint(`${label} headers`, ANSI.gray)));
    for (const [name, value] of entries) {
      const rendered = Array.isArray(value) ? value.join(', ') : value;
      this._writeLine(this._indent(`  ${this._paint(`${name}:`, ANSI.cyan)} ${rendered}`));
    }
  }

  _printBody(label, side, headers) {
    if (side.bytes === 0) return;

    const preview = previewBody(side, headers);
    if (!preview.text) {
      this._writeLine(this._indent(this._paint(`${label} body: ${preview.note || 'not captured'}`, ANSI.gray)));
      return;
    }

    const annotations = [formatBytes(preview.size)];
    if (preview.note) annotations.push(preview.note);
    if (preview.truncated) annotations.push('truncated');
    this._writeLine(this._indent(this._paint(`${label} body (${annotations.join(', ')})`, ANSI.gray)));

    const text = preview.text.slice(0, MAX_BODY_CHARS);
    const lines = text.split('\n');
    for (const line of lines.slice(0, MAX_BODY_LINES)) {
      this._writeLine(this._indent(`  ${line}`));
    }
    if (lines.length > MAX_BODY_LINES || preview.text.length > MAX_BODY_CHARS) {
      this._writeLine(this._indent(this._paint(`  … ${lines.length - MAX_BODY_LINES} more lines`, ANSI.gray)));
    }
  }

  /** A one-line summary for shutdown. */
  formatSummary(stats) {
    const transferred = stats.bytesToClient + stats.bytesFromClient;
    const parts = [
      plural(stats.requests, 'request'),
      plural(stats.tunnels, 'tunnel'),
      `${stats.denied} denied`,
      `${stats.failed} failed`,
      `${transferred ? formatBytes(transferred) : '0 B'} transferred`,
    ];
    return this._paint(parts.join(' · '), ANSI.gray);
  }

  // ----------------------------------------------------------------- helpers

  _columns() {
    return this._width || process.stdout.columns || 100;
  }

  _indent(text) {
    return `${' '.repeat(13)}${text}`;
  }

  _paint(text, code) {
    return this._color ? `${code}${text}${ANSI.reset}` : text;
  }

  _writeLine(text) {
    this._write(`${text}\n`);
  }
}

function describeTarget(record, phase) {
  if (record.kind === 'connect') {
    const verb = phase === 'close' ? 'closed' : phase === 'open' ? 'opened' : '';
    return `${record.host}:${record.port}${verb ? ` ${verb}` : ''}`;
  }

  const type = findHeader(record.response.headers, 'content-type');
  const shortType = type ? type.split(';')[0].trim() : '';
  const target = `${record.host}${record.path || ''}`;
  return shortType ? `${target}  ${shortType}` : target;
}

function totalBytes(record) {
  if (record.kind === 'connect') return record.bytesUp + record.bytesDown;
  return record.response.bytes;
}

function formatClock(timestamp) {
  const at = new Date(timestamp);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return (
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${pad(at.getMilliseconds(), 3)}`
  );
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function truncate(text, width) {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Colour only for a real terminal, and never when NO_COLOR is set. */
function supportsColor(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

module.exports = { ConsoleReporter, DETAIL_LEVELS, supportsColor, formatBytes, formatDuration };

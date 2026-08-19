'use strict';

/**
 * Turns a captured body into something worth showing in the inspector.
 *
 * The proxy forwards bodies untouched, so what it captured is usually
 * compressed and sometimes binary. Decompressing for display happens here,
 * lazily, only for the transaction the user actually selected.
 */

const zlib = require('node:zlib');

const { findHeader } = require('./headers');

const TEXTUAL_TYPES = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/xhtml',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'image/svg+xml',
];

/** Decompress per Content-Encoding. Returns the input unchanged on failure. */
function decompress(buffer, encoding) {
  if (!encoding || buffer.length === 0) return { buffer, note: null };

  const algorithm = String(encoding).split(',')[0].trim().toLowerCase();
  try {
    if (algorithm === 'gzip' || algorithm === 'x-gzip') {
      return { buffer: zlib.gunzipSync(buffer), note: 'decompressed from gzip' };
    }
    if (algorithm === 'deflate') {
      return { buffer: zlib.inflateSync(buffer), note: 'decompressed from deflate' };
    }
    if (algorithm === 'br') {
      return { buffer: zlib.brotliDecompressSync(buffer), note: 'decompressed from brotli' };
    }
  } catch {
    // A truncated capture cannot be decompressed — that is expected, not an error.
    return { buffer, note: `still ${algorithm}-encoded (capture was incomplete)` };
  }
  return { buffer, note: null };
}

function isTextualType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  return TEXTUAL_TYPES.some((prefix) => type.startsWith(prefix)) || type.endsWith('+json');
}

/** NUL bytes in the first stretch are the practical tell for binary content. */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 1024);
  return sample.includes(0);
}

function charsetOf(contentType) {
  const match = /charset=("?)([^";]+)\1/i.exec(contentType || '');
  if (!match) return 'utf8';
  const charset = match[2].trim().toLowerCase();
  if (['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset)) return 'utf8';
  if (['latin1', 'iso-8859-1'].includes(charset)) return 'latin1';
  return 'utf8';
}

/**
 * Build a display-ready view of one captured body.
 *
 * @returns {{kind: string, text: string|null, note: string|null, size: number,
 *            truncated: boolean, language: string}}
 */
function previewBody(side, headers) {
  const captured = Buffer.concat(side.chunks);
  const base = { size: side.bytes, truncated: side.truncated, note: null, language: 'text' };

  if (side.bytes === 0) return { ...base, kind: 'empty', text: null };
  if (captured.length === 0) {
    return { ...base, kind: 'not-captured', text: null, note: 'Body capture is off.' };
  }

  const contentType = findHeader(headers, 'content-type');
  const { buffer, note } = decompress(captured, findHeader(headers, 'content-encoding'));

  if (!isTextualType(contentType) && looksBinary(buffer)) {
    return {
      ...base,
      kind: 'binary',
      text: hexDump(buffer.subarray(0, 2048)),
      language: 'text',
      note: [note, `${contentType || 'unknown type'} — showing a hex dump of the first bytes`]
        .filter(Boolean)
        .join('; '),
    };
  }

  const text = buffer.toString(charsetOf(contentType));
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      return {
        ...base,
        kind: 'json',
        language: 'json',
        text: JSON.stringify(JSON.parse(text), null, 2),
        note,
      };
    } catch {
      // Truncated or malformed JSON still reads fine as plain text.
      return { ...base, kind: 'text', text, note };
    }
  }

  return { ...base, kind: 'text', text, language: languageFor(type), note };
}

function languageFor(type) {
  if (type.includes('html')) return 'html';
  if (type.includes('xml')) return 'xml';
  if (type.includes('javascript')) return 'javascript';
  if (type.includes('css')) return 'css';
  return 'text';
}

function hexDump(buffer) {
  const lines = [];
  for (let offset = 0; offset < buffer.length; offset += 16) {
    const slice = buffer.subarray(offset, offset + 16);
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

module.exports = { previewBody, isTextualType, decompress, hexDump };

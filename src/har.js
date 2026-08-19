'use strict';

/**
 * Exports recorded traffic as HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/).
 *
 * HAR is the interchange format every network tool reads, so exporting it hands
 * the traffic to Chrome DevTools, Charles, Proxyman, Postman, and friends —
 * waterfall, filtering, and body search included — without building any of it.
 *
 * Two places where honesty matters more than filling in the schema:
 *   - We time policy checks, DNS, and the TCP connect as one phase, so they go
 *     out as `connect` with `dns` marked unavailable rather than invented.
 *   - CONNECT tunnels carry no readable exchange. They are exported anyway,
 *     because knowing the workspace reached a host is worth keeping, but each
 *     one is commented so nobody reads the empty body as "no data sent".
 */

const { decompress, isTextualType } = require('./body-preview');
const { findHeader } = require('./headers');

const HAR_VERSION = '1.2';
const TUNNEL_COMMENT =
  'CONNECT tunnel. Contents are TLS-encrypted and not visible to the proxy; ' +
  'only the destination, timing, and byte counts were observed.';

/** Flatten a header map, expanding repeated headers into separate entries. */
function harHeaders(headers) {
  const out = [];
  for (const [name, value] of Object.entries(headers || {})) {
    for (const single of Array.isArray(value) ? value : [value]) {
      out.push({ name, value: String(single) });
    }
  }
  return out;
}

function harQueryString(url) {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function requestCookies(headers) {
  const raw = findHeader(headers, 'cookie');
  if (!raw) return [];

  return String(raw)
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1
        ? { name: pair, value: '' }
        : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
}

function responseCookies(headers) {
  const raw = findHeader(headers, 'set-cookie');
  if (!raw) return [];

  return (Array.isArray(raw) ? raw : [raw]).map((entry) => {
    const [pair, ...attributes] = String(entry).split(';');
    const eq = pair.indexOf('=');
    const cookie = {
      name: eq === -1 ? pair.trim() : pair.slice(0, eq).trim(),
      value: eq === -1 ? '' : pair.slice(eq + 1).trim(),
    };

    for (const attribute of attributes) {
      const [key, value = ''] = attribute.split('=');
      switch (key.trim().toLowerCase()) {
        case 'path': cookie.path = value.trim(); break;
        case 'domain': cookie.domain = value.trim(); break;
        case 'expires': cookie.expires = value.trim(); break;
        case 'httponly': cookie.httpOnly = true; break;
        case 'secure': cookie.secure = true; break;
        default: break;
      }
    }
    return cookie;
  });
}

/**
 * Build a HAR `content`/`postData` payload. Decompresses first, then keeps text
 * as text and anything binary as base64, which is what the format expects.
 */
function harBody(side, headers) {
  const mimeType = (findHeader(headers, 'content-type') || '').trim();
  const transferred = side.bytes;

  if (transferred === 0) return { size: 0, mimeType: mimeType || 'application/octet-stream' };

  const captured = Buffer.concat(side.chunks);
  if (captured.length === 0) {
    return {
      size: transferred,
      mimeType: mimeType || 'application/octet-stream',
      comment: 'Body was not captured; only its size was recorded.',
    };
  }

  const { buffer } = decompress(captured, findHeader(headers, 'content-encoding'));
  const notes = [];
  if (side.truncated) notes.push(`Body truncated: ${transferred} bytes passed through, ${captured.length} retained.`);

  const payload = {
    size: buffer.length,
    mimeType: mimeType || 'application/octet-stream',
  };
  // Bytes saved by content coding; negative values are meaningless here.
  const saved = buffer.length - transferred;
  if (saved > 0) payload.compression = saved;

  if (isTextualType(mimeType) && !buffer.subarray(0, 1024).includes(0)) {
    payload.text = buffer.toString('utf8');
  } else {
    payload.text = buffer.toString('base64');
    payload.encoding = 'base64';
  }

  if (notes.length > 0) payload.comment = notes.join(' ');
  return payload;
}

/**
 * Phase durations in HAR's vocabulary. `-1` is the format's "not applicable",
 * which is the truthful answer for phases this proxy never measures separately.
 */
function harTimings(record) {
  const { startedAt, connectedAt, firstByteAt, completedAt } = record.timings;
  const finished = completedAt ?? startedAt;

  // Refused before a socket existed: the whole life of the request was blocking.
  if (!connectedAt) {
    return { blocked: Math.max(0, finished - startedAt), dns: -1, connect: -1, send: 0, wait: -1, receive: -1, ssl: -1 };
  }

  return {
    blocked: -1,
    dns: -1,
    connect: Math.max(0, connectedAt - startedAt),
    send: 0,
    wait: firstByteAt ? Math.max(0, firstByteAt - connectedAt) : -1,
    receive: firstByteAt && completedAt ? Math.max(0, completedAt - firstByteAt) : -1,
    ssl: -1,
  };
}

/** HAR requires `time` to equal the sum of the phases it actually reports. */
function totalTime(timings) {
  return Object.values(timings)
    .filter((value) => value >= 0)
    .reduce((sum, value) => sum + value, 0);
}

function entryUrl(record) {
  if (record.kind === 'connect') return `https://${record.host}:${record.port}`;
  return record.url || `${record.scheme || 'http'}://${record.host}${record.path || ''}`;
}

function toEntry(record) {
  const isTunnel = record.kind === 'connect';
  const timings = harTimings(record);
  const url = entryUrl(record);
  const httpVersion = record.request.httpVersion ? `HTTP/${record.request.httpVersion}` : 'HTTP/1.1';

  const request = {
    method: record.method || 'GET',
    url,
    httpVersion,
    cookies: requestCookies(record.request.headers),
    headers: harHeaders(record.request.headers),
    queryString: harQueryString(url),
    headersSize: -1,
    bodySize: isTunnel ? record.bytesUp : record.request.bytes,
  };

  if (!isTunnel && record.request.bytes > 0) {
    const body = harBody(record.request, record.request.headers);
    request.postData = {
      mimeType: body.mimeType,
      text: body.text ?? '',
      params: [],
      ...(body.comment ? { comment: body.comment } : {}),
    };
  }

  const content = isTunnel
    ? { size: record.bytesDown, mimeType: 'application/octet-stream', comment: TUNNEL_COMMENT }
    : harBody(record.response, record.response.headers);

  const response = {
    status: record.response.statusCode ?? 0,
    statusText: record.response.statusMessage || '',
    httpVersion,
    cookies: responseCookies(record.response.headers),
    headers: harHeaders(record.response.headers),
    content,
    redirectURL: String(findHeader(record.response.headers, 'location') || ''),
    headersSize: -1,
    bodySize: isTunnel ? record.bytesDown : record.response.bytes,
  };

  const comments = [];
  if (isTunnel) comments.push(TUNNEL_COMMENT);
  if (record.blockedReason) comments.push(`Refused by the proxy: ${record.blockedReason}`);
  if (record.error) comments.push(`Failed: ${record.error}`);
  if (timings.connect >= 0) {
    comments.push('The "connect" phase covers policy checks, DNS, and the TCP connect, which this proxy times as one.');
  }

  const entry = {
    startedDateTime: new Date(record.timings.startedAt).toISOString(),
    time: totalTime(timings),
    request,
    response,
    cache: {},
    timings,
  };

  if (record.remoteAddress) entry.serverIPAddress = record.remoteAddress;
  if (comments.length > 0) entry.comment = comments.join(' ');
  return entry;
}

/**
 * Convert recorded transactions into a HAR 1.2 document.
 *
 * @param {object[]} records Records from a TrafficRecorder, oldest first.
 * @param {{creatorName?: string, creatorVersion?: string, includeTunnels?: boolean}} [options]
 */
function toHar(records, options = {}) {
  const includeTunnels = options.includeTunnels !== false;
  const usable = records
    .filter((record) => includeTunnels || record.kind !== 'connect')
    // An in-flight request has no duration or response yet; exporting it would
    // put a half-written entry in the file.
    .filter((record) => record.timings.completedAt);

  return {
    log: {
      version: HAR_VERSION,
      creator: {
        name: options.creatorName || 'gitpod-egress-proxy',
        version: options.creatorVersion || require('../package.json').version,
      },
      pages: [],
      entries: usable.map(toEntry),
    },
  };
}

module.exports = { toHar, toEntry, harTimings, harHeaders, harBody, totalTime, HAR_VERSION };

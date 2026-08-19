'use strict';

/**
 * Header handling for a forwarding proxy.
 *
 * RFC 9110 hop-by-hop headers apply to a single transport connection and must
 * not be passed along. `Connection` may also name additional headers that are
 * hop-by-hop for that message, so the set is computed per request.
 */

const ALWAYS_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Header names listed in `Connection`, which are hop-by-hop for this message. */
function connectionTokens(rawHeaders) {
  const tokens = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== 'connection') continue;
    for (const token of rawHeaders[i + 1].split(',')) {
      const name = token.trim().toLowerCase();
      if (name) tokens.add(name);
    }
  }
  return tokens;
}

/**
 * Rebuild headers for the upstream request, dropping hop-by-hop entries and
 * preserving duplicates (Set-Cookie, and repeated request headers) as arrays.
 * Works from rawHeaders so original casing survives the round trip.
 */
function forwardableHeaders(rawHeaders, { keepUpgrade = false } = {}) {
  const dropped = new Set([...ALWAYS_HOP_BY_HOP, ...connectionTokens(rawHeaders)]);
  if (keepUpgrade) {
    dropped.delete('upgrade');
    dropped.delete('connection');
  }

  const headers = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (dropped.has(name.toLowerCase())) continue;

    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return headers;
}

/**
 * Every header exactly as received, for display in the inspector. Unlike
 * `forwardableHeaders` this keeps hop-by-hop entries, because seeing them is
 * the point — but it redacts credentials, which must never reach a UI or a log.
 */
function allHeaders(rawHeaders) {
  const headers = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = /^(proxy-)?authorization$/i.test(name) ? '<redacted>' : rawHeaders[i + 1];

    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return headers;
}

/** Append this proxy to the `Via` chain, per RFC 9110 section 7.6.3. */
function appendVia(headers, httpVersion, pseudonym) {
  const entry = `${httpVersion} ${pseudonym}`;
  const existing = Object.keys(headers).find((name) => name.toLowerCase() === 'via');
  if (existing) {
    const current = headers[existing];
    headers[existing] = Array.isArray(current)
      ? [...current, entry].join(', ')
      : `${current}, ${entry}`;
  } else {
    headers.Via = entry;
  }
  return headers;
}

/** Case-insensitive lookup in a plain headers object. */
function findHeader(headers, name) {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers || {}).find((header) => header.toLowerCase() === wanted);
  return key ? headers[key] : null;
}

module.exports = {
  ALWAYS_HOP_BY_HOP,
  connectionTokens,
  forwardableHeaders,
  allHeaders,
  appendVia,
  findHeader,
};

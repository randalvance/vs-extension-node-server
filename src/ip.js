'use strict';

/**
 * IP literal parsing and classification.
 *
 * Used to keep the proxy from being turned into a door into the host's own
 * loopback interface or LAN. Everything here is pure and synchronous.
 */

const net = require('node:net');

/** Parse a dotted-quad into [a, b, c, d], or null if it isn't one. */
function parseIPv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Expand any IPv6 form (compressed, zoned, bracketed, v4-mapped) into eight
 * 16-bit groups, or null if it isn't a valid IPv6 address.
 */
function parseIPv6(value) {
  let addr = String(value).toLowerCase();

  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zoneAt = addr.indexOf('%');
  if (zoneAt !== -1) addr = addr.slice(0, zoneAt);
  if (!addr.includes(':')) return null;

  // Rewrite a trailing dotted-quad ("::ffff:10.0.0.1") into two hex groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const quad = parseIPv4(tail);
    if (!quad) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];

  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...rest];
  }

  const out = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function classifyIPv4(octets) {
  const [a, b, c] = octets;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade-nat';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'documentation';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark';
  if (a === 198 && b === 51 && c === 100) return 'documentation';
  if (a === 203 && b === 0 && c === 113) return 'documentation';
  if (a >= 224 && a < 240) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

function classifyIPv6(groups) {
  if (groups.every((g) => g === 0)) return 'unspecified';

  const isLoopback =
    groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return 'loopback';

  // ::ffff:0:0/96 — IPv4-mapped. Judge it by the embedded IPv4 address.
  const isV4Mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    return classifyIPv4([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }

  if ((groups[0] & 0xfe00) === 0xfc00) return 'unique-local';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((groups[0] & 0xff00) === 0xff00) return 'multicast';
  if (groups[0] === 0x0100 && groups[1] === 0) return 'discard';
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return 'documentation';
  return 'public';
}

/**
 * Classify an IP literal. Returns 'public' only for addresses that are
 * genuinely routable on the internet; anything unroutable or internal gets a
 * more specific label. Returns null when the input isn't an IP literal.
 */
function classifyAddress(value) {
  const family = net.isIP(String(value).replace(/^\[|\]$/g, '').split('%')[0]);
  if (family === 4) {
    const quad = parseIPv4(value);
    return quad ? classifyIPv4(quad) : null;
  }
  if (family === 6) {
    const groups = parseIPv6(value);
    return groups ? classifyIPv6(groups) : null;
  }
  return null;
}

/** True when the address is safe to reach on behalf of an untrusted client. */
function isPublicAddress(value) {
  return classifyAddress(value) === 'public';
}

/** True when the address is a loopback address (used for bind-safety checks). */
function isLoopbackAddress(value) {
  return classifyAddress(value) === 'loopback';
}

module.exports = {
  parseIPv4,
  parseIPv6,
  classifyIPv4,
  classifyIPv6,
  classifyAddress,
  isPublicAddress,
  isLoopbackAddress,
};

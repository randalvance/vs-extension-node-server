'use strict';

/**
 * Who may use the proxy, and what they may reach through it.
 *
 * Two independent gates:
 *   1. Proxy-Authorization (Basic), when credentials are configured.
 *   2. Destination policy — host allow/deny patterns, optional port allowlist,
 *      and a check that the destination resolves to a public address.
 *
 * The destination check resolves DNS itself and hands the caller the pinned
 * address to connect to. Resolving once and connecting to that exact address
 * closes the rebinding hole where a name passes the check and then resolves to
 * 127.0.0.1 a moment later when the socket is opened.
 */

const dns = require('node:dns');
const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');

const { classifyAddress, isPublicAddress } = require('./ip');

const DNS_CACHE_TTL_MS = 30000;

class AccessError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so the failure isn't length-distinguishable.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Match a hostname against a pattern. Supports exact names, a leading-dot or
 * `*.` wildcard covering the domain and its subdomains, and a bare `*`.
 */
function matchesHostPattern(hostname, pattern) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const rule = pattern.toLowerCase().replace(/\.$/, '');

  if (rule === '*') return true;
  if (rule.startsWith('*.')) {
    const domain = rule.slice(2);
    return host === domain || host.endsWith(`.${domain}`);
  }
  if (rule.startsWith('.')) {
    const domain = rule.slice(1);
    return host === domain || host.endsWith(`.${domain}`);
  }
  return host === rule;
}

function createAccessController(config, logger) {
  const dnsCache = new Map();

  function checkCredentials(headerValue) {
    if (!config.authEnabled) return true;
    if (typeof headerValue !== 'string') return false;

    const [scheme, encoded] = headerValue.split(/\s+/, 2);
    if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return false;

    let decoded;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return false;
    }

    const separator = decoded.indexOf(':');
    if (separator === -1) return false;

    const user = decoded.slice(0, separator);
    const pass = decoded.slice(separator + 1);
    // Both comparisons always run so a correct username can't be detected by timing.
    const userOk = safeEqual(user, config.username);
    const passOk = safeEqual(pass, config.password);
    return userOk && passOk;
  }

  function checkHostPolicy(hostname, port) {
    for (const pattern of config.denyHosts) {
      if (matchesHostPattern(hostname, pattern)) {
        throw new AccessError('host-denied', 403, `${hostname} matches a deny rule ("${pattern}")`);
      }
    }

    if (config.allowHosts.length > 0) {
      const permitted = config.allowHosts.some((pattern) => matchesHostPattern(hostname, pattern));
      if (!permitted) {
        throw new AccessError('host-not-allowed', 403, `${hostname} is not in the host allowlist`);
      }
    }

    if (config.allowPorts.length > 0 && !config.allowPorts.includes(port)) {
      throw new AccessError('port-not-allowed', 403, `Port ${port} is not in the port allowlist`);
    }
  }

  async function lookupAll(hostname) {
    const cached = dnsCache.get(hostname);
    if (cached && cached.expires > Date.now()) return cached.addresses;

    let records;
    try {
      records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new AccessError('dns-failure', 502, `Cannot resolve ${hostname}: ${error.code || error.message}`);
    }
    if (records.length === 0) {
      throw new AccessError('dns-failure', 502, `Cannot resolve ${hostname}: no addresses returned`);
    }

    const addresses = records.map((record) => ({ address: record.address, family: record.family }));
    dnsCache.set(hostname, { addresses, expires: Date.now() + DNS_CACHE_TTL_MS });
    return addresses;
  }

  /**
   * Apply the destination policy and return the address to connect to.
   * Resolves DNS when the destination is a name so the caller can pin the
   * result instead of resolving a second time.
   */
  async function resolveDestination(hostname, port) {
    if (!hostname) {
      throw new AccessError('bad-target', 400, 'Request is missing a destination host');
    }
    checkHostPolicy(hostname, port);

    const literal = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal)) {
      assertReachable(hostname, literal);
      return { address: literal, family: net.isIP(literal) };
    }

    const addresses = await lookupAll(hostname);
    const usable = config.allowPrivateNetworks
      ? addresses
      : addresses.filter((entry) => isPublicAddress(entry.address));

    if (usable.length === 0) {
      const seen = addresses.map((entry) => `${entry.address} (${classifyAddress(entry.address)})`);
      throw new AccessError(
        'private-network-blocked',
        403,
        `${hostname} resolves only to non-public addresses [${seen.join(', ')}]. ` +
          'Enable allowPrivateNetworks if reaching this host is intended.',
      );
    }

    if (usable.length < addresses.length) {
      logger.debug(`${hostname}: skipped ${addresses.length - usable.length} non-public address(es)`);
    }
    return usable[0];
  }

  function assertReachable(displayName, literal) {
    if (config.allowPrivateNetworks) return;
    if (isPublicAddress(literal)) return;
    throw new AccessError(
      'private-network-blocked',
      403,
      `${displayName} is a ${classifyAddress(literal)} address. ` +
        'Enable allowPrivateNetworks if reaching this host is intended.',
    );
  }

  return {
    checkCredentials,
    resolveDestination,
    matchesHostPattern,
    clearDnsCache: () => dnsCache.clear(),
  };
}

module.exports = { createAccessController, AccessError, matchesHostPattern };

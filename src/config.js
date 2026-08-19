'use strict';

/**
 * Configuration resolution and validation.
 *
 * Precedence: explicit overrides > environment variables > defaults. The CLI
 * and the VS Code extension both funnel into `resolveConfig`, so the two
 * surfaces cannot drift apart.
 */

const { isLoopbackAddress } = require('./ip');
const { LEVELS } = require('./logger');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8899,
  username: '',
  password: '',
  allowPrivateNetworks: false,
  allowHosts: [],
  denyHosts: [],
  allowPorts: [],
  logLevel: 'info',
  // Per-transaction log lines. The CLI turns these off while its console
  // reporter is running, since the reporter renders the same events in a
  // richer form. The VS Code extension leaves them on: its Output channel is a
  // separate surface from the inspector panel.
  logTraffic: true,
  socketTimeoutMs: 120000,
  connectTimeoutMs: 15000,
  maxConnections: 512,
  allowUnauthenticatedRemote: false,
};

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseList(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  }
  return String(value)
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parsePorts(value) {
  const list = parseList(value);
  if (!list) return undefined;
  return list.map((entry) => {
    const port = Number(entry);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`Invalid port in port allowlist: "${entry}"`);
    }
    return port;
  });
}

function parseBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`Expected a boolean value, received "${value}"`);
}

function parseInteger(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${label} must be a non-negative integer, received "${value}"`);
  }
  return parsed;
}

/** Read the subset of the environment this proxy understands. */
function configFromEnv(env = process.env) {
  return stripUndefined({
    host: env.PROXY_HOST,
    port: parseInteger(env.PROXY_PORT, 'PROXY_PORT'),
    username: env.PROXY_USERNAME,
    password: env.PROXY_PASSWORD,
    allowPrivateNetworks: parseBoolean(env.PROXY_ALLOW_PRIVATE_NETWORKS),
    allowHosts: parseList(env.PROXY_ALLOW_HOSTS),
    denyHosts: parseList(env.PROXY_DENY_HOSTS),
    allowPorts: parsePorts(env.PROXY_ALLOW_PORTS),
    logLevel: env.PROXY_LOG_LEVEL,
    logTraffic: parseBoolean(env.PROXY_LOG_TRAFFIC),
    socketTimeoutMs: parseInteger(env.PROXY_SOCKET_TIMEOUT_MS, 'PROXY_SOCKET_TIMEOUT_MS'),
    connectTimeoutMs: parseInteger(env.PROXY_CONNECT_TIMEOUT_MS, 'PROXY_CONNECT_TIMEOUT_MS'),
    maxConnections: parseInteger(env.PROXY_MAX_CONNECTIONS, 'PROXY_MAX_CONNECTIONS'),
    allowUnauthenticatedRemote: parseBoolean(env.PROXY_ALLOW_UNAUTHENTICATED_REMOTE),
  });
}

function stripUndefined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Merge defaults, environment, and explicit overrides into a validated config.
 * Throws ConfigError on anything that would produce a surprising or unsafe
 * server rather than silently correcting it.
 */
function resolveConfig(overrides = {}, env = process.env) {
  const merged = {
    ...DEFAULTS,
    ...configFromEnv(env),
    ...stripUndefined({
      ...overrides,
      allowHosts: parseList(overrides.allowHosts),
      denyHosts: parseList(overrides.denyHosts),
      allowPorts: parsePorts(overrides.allowPorts),
      allowPrivateNetworks: parseBoolean(overrides.allowPrivateNetworks),
      logTraffic: parseBoolean(overrides.logTraffic),
      allowUnauthenticatedRemote: parseBoolean(overrides.allowUnauthenticatedRemote),
      port: parseInteger(overrides.port, 'port'),
      socketTimeoutMs: parseInteger(overrides.socketTimeoutMs, 'socketTimeoutMs'),
      connectTimeoutMs: parseInteger(overrides.connectTimeoutMs, 'connectTimeoutMs'),
      maxConnections: parseInteger(overrides.maxConnections, 'maxConnections'),
    }),
  };

  if (merged.port < 0 || merged.port > 65535) {
    throw new ConfigError(`port must be between 0 and 65535, received ${merged.port}`);
  }
  if (!(merged.logLevel in LEVELS)) {
    throw new ConfigError(
      `logLevel must be one of ${Object.keys(LEVELS).join(', ')}, received "${merged.logLevel}"`,
    );
  }
  if (Boolean(merged.username) !== Boolean(merged.password)) {
    throw new ConfigError('username and password must be set together, or neither');
  }

  const authEnabled = Boolean(merged.username && merged.password);
  const boundToLoopback = isLoopbackAddress(merged.host) || merged.host === 'localhost';

  if (!boundToLoopback && !authEnabled && !merged.allowUnauthenticatedRemote) {
    throw new ConfigError(
      `Refusing to bind ${merged.host} without credentials: an open proxy on a ` +
        'non-loopback interface is reachable by anything on your network. Set a ' +
        'username and password, bind 127.0.0.1 and use an SSH reverse tunnel, or ' +
        'pass --allow-unauthenticated-remote if you truly intend this.',
    );
  }

  return { ...merged, authEnabled, boundToLoopback };
}

module.exports = { DEFAULTS, ConfigError, resolveConfig, configFromEnv };

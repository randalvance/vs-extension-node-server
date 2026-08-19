'use strict';

const fs = require('node:fs');

/**
 * Command-line front end: argument parsing, startup banner, signal handling.
 */

const { ProxyServer } = require('./proxy');
const { ConfigError } = require('./config');
const { workspaceEnvSnippet, tunnelCommand } = require('./client-config');
const { ConsoleReporter, DETAIL_LEVELS } = require('./console-reporter');
const { toHar } = require('./har');

const USAGE = `
gitpod-egress-proxy — an HTTP/HTTPS forward proxy for giving a remote
workspace internet access through this machine.

Usage:
  node server.js [options]

Options:
  -p, --port <number>          Port to listen on (default 8899)
  -H, --host <address>         Address to bind (default 127.0.0.1)
  -u, --username <name>        Require Basic proxy auth with this username
  -w, --password <secret>      Password for proxy auth
      --allow <patterns>       Only permit these destination hosts.
                               Comma-separated; "*.example.com" matches subdomains.
      --deny <patterns>        Always refuse these destination hosts.
      --allow-ports <list>     Only permit these destination ports.
      --allow-private          Permit destinations on private/loopback ranges.
                               Off by default so the workspace cannot reach your LAN.
      --allow-unauthenticated-remote
                               Permit binding a non-loopback address without a password.
      --inspect [level]        Network log detail: compact | headers | bodies.
                               Defaults to compact; bare --inspect means headers.
      --no-inspect             Drop the network log and fall back to plain
                               timestamped log lines (better for piping to a file).
      --no-color               Plain output with no ANSI colour.
      --har <file>             On exit, write all traffic to a HAR file. Open it
                               in Chrome DevTools, Charles, Proxyman, or Postman.
      --log-level <level>      silent | error | warn | info | debug (default info)
      --socket-timeout <ms>    Idle timeout for proxied connections (default 120000)
      --connect-timeout <ms>   Timeout for reaching an upstream host (default 15000)
      --max-connections <n>    Concurrent client connection cap (default 512)
      --ssh-target <target>    Shown in the startup banner's tunnel example
  -h, --help                   Show this help
  -v, --version                Show the version

Every option also reads from the environment: PROXY_PORT, PROXY_HOST,
PROXY_USERNAME, PROXY_PASSWORD, PROXY_ALLOW_HOSTS, PROXY_DENY_HOSTS,
PROXY_ALLOW_PORTS, PROXY_ALLOW_PRIVATE_NETWORKS, PROXY_LOG_LEVEL,
PROXY_SOCKET_TIMEOUT_MS, PROXY_CONNECT_TIMEOUT_MS, PROXY_MAX_CONNECTIONS.
`.trimStart();

const FLAGS = {
  '-p': 'port',
  '--port': 'port',
  '-H': 'host',
  '--host': 'host',
  '-u': 'username',
  '--username': 'username',
  '-w': 'password',
  '--password': 'password',
  '--allow': 'allowHosts',
  '--deny': 'denyHosts',
  '--allow-ports': 'allowPorts',
  '--log-level': 'logLevel',
  '--socket-timeout': 'socketTimeoutMs',
  '--connect-timeout': 'connectTimeoutMs',
  '--max-connections': 'maxConnections',
  '--ssh-target': 'sshTarget',
  '--har': 'harPath',
};

const BOOLEAN_FLAGS = {
  '--allow-private': 'allowPrivateNetworks',
  '--allow-unauthenticated-remote': 'allowUnauthenticatedRemote',
};

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-v' || arg === '--version') return { version: true };

    if (arg === '--no-inspect') {
      options.inspect = false;
      continue;
    }
    if (arg === '--no-color') {
      options.color = false;
      continue;
    }

    // --inspect takes an optional level. The levels are a closed set, so a
    // following word that is not one of them belongs to the next flag.
    if (arg === '--inspect') {
      const next = argv[i + 1];
      if (DETAIL_LEVELS.includes(next)) {
        options.inspect = next;
        i += 1;
      } else {
        options.inspect = 'headers';
      }
      continue;
    }
    if (arg.startsWith('--inspect=')) {
      const level = arg.slice('--inspect='.length);
      if (!DETAIL_LEVELS.includes(level)) {
        throw new UsageError(`--inspect must be one of ${DETAIL_LEVELS.join(', ')}, got "${level}"`);
      }
      options.inspect = level;
      continue;
    }

    if (arg in BOOLEAN_FLAGS) {
      options[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }

    // Accept both "--port 8899" and "--port=8899".
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!(name in FLAGS)) throw new UsageError(`Unknown option: ${arg}`);

    let value;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`Option ${name} requires a value`);
      }
      i += 1;
    }
    options[FLAGS[name]] = value;
  }
  return { options };
}

function describeInspect(inspect) {
  if (!inspect) return 'off';
  if (inspect === 'compact') return 'on (one line per request)';
  if (inspect === 'headers') return 'on, with headers';
  return 'on, with headers and bodies';
}

function banner(server, sshTarget, inspect, harPath) {
  const address = server.address();
  const { config } = server;
  const lines = [
    '',
    '  Proxy is up.',
    '',
    `    listening   http://${address.host}:${address.port}`,
    `    auth        ${config.authEnabled ? `Basic (user "${config.username}")` : 'none'}`,
    `    private net ${config.allowPrivateNetworks ? 'allowed' : 'blocked'}`,
  ];

  if (config.allowHosts.length > 0) lines.push(`    allowlist   ${config.allowHosts.join(', ')}`);
  if (config.denyHosts.length > 0) lines.push(`    denylist    ${config.denyHosts.join(', ')}`);
  lines.push(`    network log ${describeInspect(inspect)}`);
  if (harPath) lines.push(`    har         writing to ${harPath} on exit`);

  lines.push(
    '',
    '  1. From this machine, open a reverse tunnel into the workspace:',
    '',
    `       ${tunnelCommand({ port: address.port, sshTarget })}`,
    '',
    '  2. Inside the workspace:',
    '',
    workspaceEnvSnippet({
      port: address.port,
      username: config.username,
      password: config.password,
    })
      .split('\n')
      .map((line) => `       ${line}`)
      .join('\n'),
    '',
    '  3. Verify from the workspace:',
    '',
    '       curl -sS https://api.ipify.org && echo',
    '',
  );
  return lines.join('\n');
}

function writeHar(harPath, recorder) {
  const har = toHar(recorder.list());
  try {
    fs.writeFileSync(harPath, `${JSON.stringify(har, null, 2)}\n`);
    process.stdout.write(`Wrote ${har.log.entries.length} entries to ${harPath}\n`);
  } catch (error) {
    process.stderr.write(`Could not write ${harPath}: ${error.message}\n`);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\nRun with --help for usage.\n`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${require('../package.json').version}\n`);
    return 0;
  }

  const { sshTarget, inspect, color, harPath, ...overrides } = parsed.options;
  // The network log is on by default; --no-inspect sets it to false.
  const detail = inspect === undefined ? 'compact' : inspect;

  let server;
  try {
    server = new ProxyServer(
      // The reporter renders traffic itself, so the proxy's own per-request
      // lines would be a second copy of the same events.
      { ...overrides, logTraffic: detail === false },
      { env },
    );
    await server.start();
  } catch (error) {
    const prefix = error instanceof ConfigError ? 'Configuration error' : 'Failed to start';
    process.stderr.write(`${prefix}: ${error.message}\n`);
    return 1;
  }

  let reporter = null;
  if (detail !== false) {
    reporter = new ConsoleReporter(server.recorder, { detail, color });
    server.recorder.configure({
      captureBodies: reporter.needsBodies,
      // Nothing here needs history — each transaction is printed and forgotten.
      maxEntries: 64,
    });
    server.recorder.setEnabled(true);
    reporter.start();
  }

  // A HAR is written from history, so exporting one needs that history kept —
  // and its bodies — regardless of how little the console log itself shows.
  if (harPath) {
    server.recorder.configure({ captureBodies: true, maxEntries: 10000 });
    server.recorder.setEnabled(true);
  }

  process.stdout.write(banner(server, sshTarget, detail, harPath));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}, shutting down.\n`);

    // Stop first: closing the listener tears down live tunnels, and their
    // closing lines and byte totals only exist once those sockets have gone.
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (reporter) {
      process.stdout.write(`${reporter.formatSummary(server.snapshot())}\n`);
      reporter.stop();
    }
    if (harPath) writeHar(harPath, server.recorder);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return new Promise(() => {}); // Run until a signal arrives.
}

module.exports = { main, parseArgs, USAGE };

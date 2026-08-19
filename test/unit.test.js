'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyAddress, isPublicAddress, parseIPv6 } = require('../src/ip');
const { forwardableHeaders, appendVia, connectionTokens } = require('../src/headers');
const { resolveConfig, ConfigError } = require('../src/config');
const { matchesHostPattern } = require('../src/access');
const { parseAuthority } = require('../src/proxy');
const { parseArgs } = require('../src/cli');
const { workspaceEnvSnippet } = require('../src/client-config');

test('classifies IPv4 addresses', () => {
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.32.0.1'), 'public');
  assert.equal(classifyAddress('192.168.1.1'), 'private');
  assert.equal(classifyAddress('169.254.169.254'), 'link-local');
  assert.equal(classifyAddress('100.64.0.1'), 'carrier-grade-nat');
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
});

test('classifies IPv6 addresses, including v4-mapped forms', () => {
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('fd00::1'), 'unique-local');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:8.8.8.8'), 'public');
  assert.equal(classifyAddress('[::1]'), 'loopback');
  assert.equal(classifyAddress('fe80::1%en0'), 'link-local');
});

test('rejects non-addresses', () => {
  assert.equal(classifyAddress('example.com'), null);
  assert.equal(classifyAddress('999.1.1.1'), null);
  assert.equal(isPublicAddress('example.com'), false);
});

test('expands compressed IPv6 to eight groups', () => {
  assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6('2001:db8::8:800:200c:417a'), [
    0x2001, 0x0db8, 0, 0, 8, 0x800, 0x200c, 0x417a,
  ]);
  assert.equal(parseIPv6('1::2::3'), null);
});

test('drops hop-by-hop headers and preserves duplicates', () => {
  const raw = [
    'Host', 'example.com',
    'Connection', 'keep-alive, X-Custom',
    'Proxy-Authorization', 'Basic secret',
    'X-Custom', 'dropped-because-named-by-connection',
    'Accept', 'text/html',
    'Accept', 'application/json',
    'Transfer-Encoding', 'chunked',
  ];
  const headers = forwardableHeaders(raw);

  assert.equal(headers.Host, 'example.com');
  assert.deepEqual(headers.Accept, ['text/html', 'application/json']);
  assert.equal(headers.Connection, undefined);
  assert.equal(headers['Proxy-Authorization'], undefined);
  assert.equal(headers['X-Custom'], undefined);
  assert.equal(headers['Transfer-Encoding'], undefined);
});

test('keeps upgrade headers when tunnelling a protocol switch', () => {
  const raw = ['Connection', 'Upgrade', 'Upgrade', 'websocket', 'Host', 'example.com'];
  const headers = forwardableHeaders(raw, { keepUpgrade: true });
  assert.equal(headers.Upgrade, 'websocket');
  assert.equal(headers.Connection, 'Upgrade');
});

test('reads extra hop-by-hop names out of Connection', () => {
  const tokens = connectionTokens(['Connection', 'keep-alive, Foo , Bar']);
  assert.deepEqual([...tokens].sort(), ['bar', 'foo', 'keep-alive']);
});

test('appends to an existing Via chain', () => {
  assert.equal(appendVia({}, '1.1', 'proxy').Via, '1.1 proxy');
  assert.equal(appendVia({ Via: '1.0 other' }, '1.1', 'proxy').Via, '1.0 other, 1.1 proxy');
});

test('matches host patterns', () => {
  assert.ok(matchesHostPattern('example.com', 'example.com'));
  assert.ok(matchesHostPattern('EXAMPLE.com', 'example.com'));
  assert.ok(matchesHostPattern('api.example.com', '*.example.com'));
  assert.ok(matchesHostPattern('example.com', '*.example.com'));
  assert.ok(matchesHostPattern('api.example.com', '.example.com'));
  assert.ok(matchesHostPattern('anything', '*'));
  assert.ok(!matchesHostPattern('notexample.com', '*.example.com'));
  assert.ok(!matchesHostPattern('example.com.evil.net', 'example.com'));
});

test('parses CONNECT authorities', () => {
  assert.deepEqual(parseAuthority('example.com:443', 443), { hostname: 'example.com', port: 443 });
  assert.deepEqual(parseAuthority('example.com', 443), { hostname: 'example.com', port: 443 });
  assert.deepEqual(parseAuthority('[::1]:8080', 443), { hostname: '::1', port: 8080 });
  assert.deepEqual(parseAuthority('[::1]', 443), { hostname: '::1', port: 443 });
  assert.equal(parseAuthority('example.com:notaport', 443), null);
  assert.equal(parseAuthority('example.com:99999', 443), null);
});

test('resolves configuration from defaults, env, and overrides in order', () => {
  const config = resolveConfig({ port: 9000 }, { PROXY_PORT: '7000', PROXY_LOG_LEVEL: 'debug' });
  assert.equal(config.port, 9000, 'explicit override wins over env');
  assert.equal(config.logLevel, 'debug', 'env wins over default');
  assert.equal(config.host, '127.0.0.1', 'default applies when unset');
  assert.equal(config.authEnabled, false);
});

test('refuses a non-loopback bind without credentials', () => {
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }, {}), ConfigError);
  assert.doesNotThrow(() =>
    resolveConfig({ host: '0.0.0.0', username: 'u', password: 'p' }, {}),
  );
  assert.doesNotThrow(() =>
    resolveConfig({ host: '0.0.0.0', allowUnauthenticatedRemote: true }, {}),
  );
});

test('rejects a half-configured credential pair', () => {
  assert.throws(() => resolveConfig({ username: 'u' }, {}), ConfigError);
  assert.throws(() => resolveConfig({ password: 'p' }, {}), ConfigError);
});

test('rejects invalid log levels and ports', () => {
  assert.throws(() => resolveConfig({ logLevel: 'chatty' }, {}), ConfigError);
  assert.throws(() => resolveConfig({ port: 70000 }, {}), ConfigError);
});

test('parses host lists from a comma-separated string or an array', () => {
  const fromString = resolveConfig({ allowHosts: 'A.com, b.com' }, {});
  assert.deepEqual(fromString.allowHosts, ['a.com', 'b.com']);
  const fromArray = resolveConfig({ allowHosts: ['A.com', 'b.com'] }, {});
  assert.deepEqual(fromArray.allowHosts, ['a.com', 'b.com']);
});

test('parses CLI arguments in both spaced and equals forms', () => {
  const { options } = parseArgs(['--port', '9000', '--host=0.0.0.0', '--allow-private']);
  assert.equal(options.port, '9000');
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.allowPrivateNetworks, true);

  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['--nonsense']), /Unknown option/);
  assert.throws(() => parseArgs(['--port']), /requires a value/);
});

test('builds a workspace snippet, escaping credentials', () => {
  const plain = workspaceEnvSnippet({ port: 8899 });
  assert.match(plain, /export HTTP_PROXY=http:\/\/127\.0\.0\.1:8899/);
  assert.match(plain, /export NO_PROXY=localhost,127\.0\.0\.1,::1,\.internal/);

  const authenticated = workspaceEnvSnippet({ port: 8899, username: 'a b', password: 'p@ss' });
  assert.match(authenticated, /http:\/\/a%20b:p%40ss@127\.0\.0\.1:8899/);
});

# Gitpod Egress Proxy

An HTTP/HTTPS forward proxy that runs on your laptop so a Gitpod/Ona workspace
can reach the internet through your machine's connection.

It runs two ways from the same code: as a plain `node server.js`, or as a VS
Code extension. The extension path exists for machines with no Node.js
installed — the extension host provides the runtime, and since the proxy uses
**only Node core modules**, there is nothing to `npm install` and nothing to
compile.

## What it does

- Forwards plain HTTP (absolute-URI requests)
- Tunnels HTTPS and anything else over TLS via `CONNECT`
- Passes through WebSocket `Upgrade`
- Optional Basic authentication
- Host allow/deny lists and a port allowlist
- Blocks destinations that resolve to private, loopback, and link-local
  addresses, so the workspace cannot use the proxy to poke at your LAN
- A [traffic inspector](#traffic-inspector) — a panel in VS Code, a network log
  in the terminal, and [HAR export](#export-as-har) for everything else

## Quick start

### As a VS Code extension (no Node.js needed)

```bash
./scripts/install-vscode-extension.sh
```

Fully restart VS Code, then run **Gitpod Proxy: Start Proxy** from the command
palette. A status bar item appears; click it for start/stop, traffic stats, and
a **Copy Workspace Configuration** command that puts the right `export` block on
your clipboard.

The extension is marked `extensionKind: ["ui"]`, so when your window is attached
to a remote workspace it still runs locally — which is the point, since the
workspace needs *this* machine's network.

Configure it under Settings → Extensions → Gitpod Egress Proxy. The password
lives in VS Code's secret store rather than in `settings.json`; set it with
**Gitpod Proxy: Set Proxy Password**.

### As a Node.js server

```bash
node server.js
```

```bash
node server.js --port 8899 --username gitpod --password "$(openssl rand -base64 24)"
```

`node server.js --help` lists every option. All of them also read from the
environment (`PROXY_PORT`, `PROXY_USERNAME`, …), which is what the Docker path
uses.

### With Docker Desktop

```bash
docker compose up --build
```

## Traffic inspector

Both ways of running the proxy show you the traffic going through it: a panel in
VS Code, and a network log in the terminal on the CLI. Both read the same
recorder, so they report identically.

### In the terminal

`node server.js` prints a network log by default — one aligned line per
transaction:

```
14:08:47.658 200 GET     api.github.com/repos/x/y  application/json      1.2 kB      142ms
14:08:47.677 404 GET     registry.npmjs.org/nope   text/plain               9 B        1ms
14:08:47.689 ··· CONNECT api.ipify.org:443 opened
14:08:47.702 403 GET     analytics.tracking.test/collect                    —          0ms
             ↳ analytics.tracking.test matches a deny rule ("*.tracking.test")
14:08:49.589 200 CONNECT api.ipify.org:443 closed                       3.5 kB       1.90s
```

Tunnels print twice — once on open, so a long-lived HTTPS connection shows up
immediately instead of looking like a hung proxy, and once on close with the
byte totals. Refused requests carry the rule that blocked them.

Add detail with `--inspect`:

```bash
node server.js --inspect bodies
```

| Flag | |
|---|---|
| `--inspect compact` | One line per transaction. The default. |
| `--inspect` or `--inspect headers` | Adds request and response headers. |
| `--inspect bodies` | Adds decoded bodies as well. |
| `--no-inspect` | Falls back to plain timestamped log lines, better for piping to a file. |
| `--no-color` | No ANSI colour. Also honours `NO_COLOR`, and turns itself off when stdout is not a terminal. |
| `--har <file>` | Write every transaction to a HAR file on exit. See [below](#export-as-har). |

Bodies are decompressed and pretty-printed the same way the panel does it, and
capped so a large download cannot flood your scrollback.

### Export as HAR

HAR is the interchange format every network tool reads, so exporting one hands
the traffic to better tools than either of ours:

```bash
node server.js --har traffic.har
```

The file is written when the proxy exits. In VS Code, **Gitpod Proxy: Export
Traffic as HAR** opens a save dialog instead.

Then drag the file into Chrome DevTools' Network panel — you get its waterfall,
type filters, body search, and copy-as-cURL over your proxy's traffic. Charles,
Proxyman, and Postman import the same file, and it travels, so you can hand it
to someone else to look at.

Two things are worth knowing about what comes out:

- **Bodies are decompressed.** gzip, deflate, and brotli are decoded, with
  `content.compression` reporting the bytes the coding saved. Binary bodies are
  base64-encoded, as the format expects.
- **We time policy checks, DNS, and the TCP connect as one phase**, so they are
  reported as `connect` with `dns` marked unavailable rather than invented.
  Requests the proxy refused show that time as `blocked`, and carry the rule
  that stopped them in the entry's comment.

CONNECT tunnels are included, since knowing the workspace reached a host is
worth keeping, but each one is commented so an empty body is not misread as "no
data sent". `--har` implies body capture and a larger history than the console
log alone keeps.

### In VS Code

**Gitpod Proxy: Open Traffic Inspector** opens a DevTools-style panel listing
every transaction as it happens — status, method, host, path, size, and elapsed
time — with a detail pane showing request and response headers, both bodies, and
a timing breakdown. It starts the proxy if it is not already running.

Bodies are decoded for display: gzip, deflate, and brotli are decompressed, JSON
is pretty-printed, and binary content is shown as a hex dump instead of mojibake.
Requests the proxy *refused* are listed too, each with the rule that blocked it,
which is usually the fastest way to find out why something in the workspace
cannot reach the network.

### What neither one can show you

For `https://` URLs the proxy sees a `CONNECT` tunnel and nothing more. The
payload is encrypted between the workspace and the origin server, so the panel
reports the destination, timing, and bytes transferred, and says plainly that
the headers and body are not visible. Reading those would mean terminating TLS
with a certificate authority installed in the workspace's trust store — a
different feature, and one that would cost this project its zero-dependency
install.

Plain HTTP is fully visible, which covers most local services, internal
endpoints, and anything not yet on TLS.

### Cost and limits

Recording is off unless something is watching — a closed panel and
`--no-inspect` both cost nothing. The CLI keeps only a small ring buffer, since
it prints each transaction and forgets it, and skips body capture entirely
below `--inspect bodies`. The panel keeps history so you can click back through
it:

| Setting | Default | |
|---|---|---|
| `gitpodProxy.inspector.maxTransactions` | 500 | Older transactions are dropped as new ones arrive. |
| `gitpodProxy.inspector.maxBodyBytes` | 262144 | Bodies past this are shown truncated. |
| `gitpodProxy.inspector.captureBodies` | true | Turn off to record only headers, status, and timing. |

`Authorization` and `Proxy-Authorization` headers are redacted before a
transaction is recorded, so credentials never reach the panel.

## Connecting the workspace

The proxy is only half the job — your laptop is behind NAT, so something has to
carry the connection inward. The short version, using SSH from your laptop:

```bash
ssh -N -R 8899:127.0.0.1:8899 <workspace-ssh-target>
```

Then inside the workspace:

```bash
export HTTP_PROXY=http://127.0.0.1:8899
export HTTPS_PROXY=http://127.0.0.1:8899
export NO_PROXY=localhost,127.0.0.1,::1,.internal
```

Verify with `curl -sS https://api.ipify.org` — it should print your laptop's
public IP.

[docs/gitpod-setup.md](docs/gitpod-setup.md) covers the alternatives (Tailscale,
ngrok TCP), the tools that ignore `HTTP_PROXY` and what to do about them, and
troubleshooting.

### Browser logins are the other direction

If you need an SSO or OAuth login from the workspace — PingOne, Okta, a cloud
CLI — this proxy is not what carries it. The provider redirects *your laptop's*
browser to a `localhost` callback that the workspace is listening on, which is
inbound port forwarding, not egress. VS Code Remote already does it; see
[Browser-based logins](docs/gitpod-setup.md#browser-based-logins-sso-oauth-pingone)
for the setup, the failure modes, and why the device code flow avoids the
problem entirely.

## Security defaults

This proxy gets exposed to a remote machine, so the defaults lean closed:

- **Binds `127.0.0.1`.** Reachable through your tunnel, not from your network.
- **Refuses to bind a non-loopback address without credentials.** An open proxy
  on a LAN interface is a genuine hazard; you have to pass
  `--allow-unauthenticated-remote` to say you mean it.
- **Blocks private, loopback, and link-local destinations.** Without this, a
  workspace could reach your router's admin page or a database on your laptop.
  Turn it on with `--allow-private` when you actually want that.
- **Resolves DNS once and pins the result.** The address the policy approved is
  the address the socket connects to, so a name cannot pass the check and then
  resolve somewhere else a moment later.
- **Strips hop-by-hop headers**, including `Proxy-Authorization`, so credentials
  never reach the origin server.

Narrow it further when you know what the workspace needs:

```bash
node server.js --allow '*.github.com,*.npmjs.org,registry.npmjs.org'
```

## Endpoints on the proxy itself

Request these directly rather than through it:

| Path | Purpose |
|------|---------|
| `/healthz` | Liveness check. Unauthenticated, so it works for testing a tunnel. |
| `/stats` | Traffic counters as JSON. Requires credentials when auth is on. |
| `/proxy.pac` | Proxy auto-config file, for clients that want one. |

## Layout

```
server.js                  CLI entry point
extension.js               VS Code entry point
inspector-panel.js         webview panel, bridges the recorder to the UI
media/                     inspector webview (HTML, CSS, JS)
src/proxy.js               the proxy — HTTP forwarding, CONNECT, Upgrade
src/access.js              authentication, host/port policy, pinned DNS resolution
src/config.js              defaults, environment, and validation
src/headers.js             hop-by-hop header handling
src/ip.js                  IP parsing and classification
src/traffic-recorder.js    bounded in-memory record of transactions
src/console-reporter.js    renders that record as the CLI's network log
src/har.js                 exports that record as HAR 1.2
src/body-preview.js        decompresses and formats bodies for display
src/transaction-detail.js  assembles the detail view for one transaction
src/client-config.js       generates the workspace snippet, shared by both entries
```

Everything under `src/` is free of VS Code imports, so the proxy and the
recording pipeline are testable without an extension host.

## Tests

```bash
node --test 'test/*.test.js'
```

The suite runs the real proxy against real upstream servers on loopback: HTTP
forwarding, CONNECT tunnelling, authentication, the allow/deny lists, the
private-network block, the traffic recording behind the inspector, and the
HAR export against the spec's required fields.

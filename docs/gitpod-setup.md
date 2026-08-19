# Connecting a Gitpod/Ona workspace to the proxy

The proxy itself is the easy half. The harder half is reachability: your laptop
sits behind NAT, so the workspace cannot simply dial it. Something has to carry
the connection inward.

## Which direction does traffic actually flow?

Worth being precise, because the naming trips people up. You want a **forward
proxy**: the workspace's HTTP clients are configured to send their requests to
the proxy, and the proxy makes those requests on their behalf, from your
laptop's IP address.

```
workspace tool          tunnel                 this laptop            internet
(curl, git, npm)  ──►  127.0.0.1:8899  ──►  proxy on 127.0.0.1  ──►  origin server
```

The workspace always dials `127.0.0.1:8899` — its *own* loopback. The tunnel is
what makes that local port come out on your laptop.

## Option 1: SSH reverse tunnel (recommended)

Gitpod and Ona both expose SSH access to a running workspace, and OpenSSH ships
on macOS, so this needs nothing installed.

Start the proxy, then from **your laptop**:

```bash
ssh -N -R 8899:127.0.0.1:8899 <workspace-ssh-target>
```

`-R` asks the remote side to listen on port 8899 and forward anything arriving
there back down the existing connection to `127.0.0.1:8899` on your laptop.
`-N` means "don't run a command, just hold the tunnel open."

Get the SSH target from the Gitpod dashboard ("Connect via SSH") or the CLI:

```bash
gitpod workspace ssh <workspace-id> --dry-run
```

Then, inside the workspace:

```bash
export HTTP_PROXY=http://127.0.0.1:8899
export HTTPS_PROXY=http://127.0.0.1:8899
export http_proxy=$HTTP_PROXY
export https_proxy=$HTTPS_PROXY
export NO_PROXY=localhost,127.0.0.1,::1,.internal
export no_proxy=$NO_PROXY
```

The **Copy Workspace Configuration** command (or the CLI startup banner)
generates this block with your port and credentials already filled in.

Keep the tunnel alive across flaky networks:

```bash
ssh -N -R 8899:127.0.0.1:8899 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    <workspace-ssh-target>
```

`ExitOnForwardFailure=yes` matters: without it, SSH connects happily even when
the remote port is already taken, and you get a tunnel that silently forwards
nothing.

## Option 2: Tailscale

Useful if you want the link to survive reconnects on its own. Join both your
laptop and the workspace to the same tailnet, then point the workspace at your
laptop's tailnet address instead of loopback:

```bash
export HTTP_PROXY=http://100.x.y.z:8899
```

Because the workspace is no longer dialing its own loopback, the proxy must bind
an address Tailscale can reach, which means it is no longer protected by being
loopback-only. Set a username and password:

```bash
node server.js --host 0.0.0.0 --username gitpod --password "$(openssl rand -base64 24)"
```

The proxy refuses to bind a non-loopback address without credentials, precisely
to stop this from becoming an open proxy by accident.

## Option 3: ngrok TCP

```bash
ngrok tcp 8899
```

Use the **TCP** tunnel, not the HTTP one. An HTTP tunnel (ngrok's `http` mode,
Cloudflare Quick Tunnels) terminates and re-issues HTTP requests, which breaks
`CONNECT` — so HTTPS through the proxy will not work. A TCP tunnel passes bytes
through untouched, which is what a proxy needs.

Anything reachable on the public internet needs credentials. Set them.

## Verifying it works

From inside the workspace:

```bash
# Should print your laptop's public IP, not the workspace's.
curl -sS https://api.ipify.org && echo

# Confirms the tunnel reaches the proxy at all, independent of egress.
curl -sS http://127.0.0.1:8899/healthz && echo
```

If the first command prints an address belonging to your cloud provider, the
environment variables are not being read by the tool you are testing.

## Things that do not read `HTTP_PROXY`

Environment variables are a convention, not a protocol, and coverage is uneven.

| Tool | Notes |
|------|-------|
| `curl`, `wget`, `pip`, `npm`, `yarn`, Go modules | Read the variables directly. |
| `git` | Reads them for HTTPS remotes. SSH remotes ignore them entirely — see below. |
| `apt` | Needs `Acquire::http::Proxy "http://127.0.0.1:8899";` in `/etc/apt/apt.conf.d/`. |
| Docker daemon inside the workspace | Reads its own config, not your shell. Set `proxies` in `~/.docker/config.json` or the daemon's systemd drop-in. |
| Java | Needs `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=8899` (and the `https.*` pair). |

For `git` over SSH, either switch the remote to HTTPS or add to `~/.ssh/config`
in the workspace:

```
Host github.com
  ProxyCommand nc -X connect -x 127.0.0.1:8899 %h %p
```

## Browser-based logins (SSO, OAuth, PingOne)

This one catches people out, because it needs the **opposite** of what this
proxy does — and the proxy cannot help with it.

| | Direction | Purpose |
|---|---|---|
| This proxy | workspace → internet, via your laptop | Egress |
| A browser login | your laptop's browser → workspace's `localhost` | Receiving the callback |

A forward proxy only carries outbound requests. Your browser reaching *into* the
workspace is **port forwarding**, a separate mechanism — and one VS Code Remote
already does for you.

### Why the callback needs it

A CLI doing OIDC uses a loopback redirect (RFC 8252):

1. The tool, **in the workspace**, listens on `http://localhost:8080/callback`.
2. It opens the provider's authorize URL.
3. You sign in **in your laptop's browser** — that is where your MFA, passkeys,
   and existing SSO session live.
4. The provider redirects your **laptop** browser to
   `http://localhost:8080/callback?code=...`.
5. The tool exchanges that code for tokens.

Step 4 is the catch: the browser hits *your laptop's* loopback, but the listener
is in the workspace. Port forwarding bridges the two — VS Code notices something
listening on 8080 in the workspace and binds 8080 on your laptop, tunnelling it
down the connection you already have.

In practice: **start the login from a terminal inside VS Code while connected to
the workspace**, and it generally works. Check the Ports panel to confirm the
port is forwarded.

### What goes wrong, roughly by frequency

**Port already taken on your laptop.** If your laptop's 8080 is busy, VS Code
forwards to 8081 instead and says nothing, so the redirect to `localhost:8080`
reaches some other process. The symptom is a login that completes in the browser
and then hangs forever. Free the port, or pin the mapping in the Ports panel.

**The tool picks a random port.** Auto-forwarding usually catches it, but a port
chosen after the browser opens can lose the race. If the tool takes a `--port`
flag, set one.

**Redirect URI mismatch.** It must match your provider's registered value
exactly. `http://localhost:8080/callback` and `http://127.0.0.1:8080/callback`
are different strings to an OIDC provider.

**No browser in the workspace.** If the tool tries to launch one and fails, copy
the URL and paste it into your laptop browser yourself. VS Code Remote normally
points `$BROWSER` at a shim that opens locally.

**The provider requires an HTTPS redirect.** Loopback `http://` will be refused
for that app type. You would need the workspace's public port URL as the
redirect instead, which changes per workspace and is awkward to register.

### Prefer the device code flow where you can

If the provider supports the **Device Authorization Grant** (RFC 8628) — PingOne
among others does — use it. The tool prints a code and a URL, you open it on any
device, and there is **no callback listener at all**: no port to forward, no
collision, nothing to bridge. It exists for exactly this situation. Worth
checking for a `--device-code` option before fighting the loopback flow.

### Where this proxy still matters

Two things, both secondary to the login itself:

- **The back channel.** After the callback, the tool calls the provider's token
  endpoint directly from the workspace. If the workspace has no internet of its
  own, that request goes through this proxy.
- **A trap the generated snippet avoids.** With `HTTP_PROXY` set and no
  exclusion for loopback, the tool's own request to `http://localhost:8080`
  would be sent out through the proxy — which blocks loopback destinations by
  default, failing the login for a reason that looks nothing like the cause.
  The snippet in this guide sets
  `NO_PROXY=localhost,127.0.0.1,::1,.internal` for that reason. Keep that line.

Do not expect the traffic inspector to show you the login. The provider is
HTTPS, so it appears only as `CONNECT auth.example.com:443`, and the one
plaintext part — the `localhost` callback — deliberately bypasses the proxy.

## Troubleshooting

**`curl: (56) CONNECT tunnel failed, response 403`** — the proxy refused the
destination. Check its log: it will name the rule that matched, either a deny
pattern, a missing allowlist entry, or the private-network block. In VS Code,
**Gitpod Proxy: Open Traffic Inspector** lists refused requests alongside
successful ones, each with the reason it was blocked.

**Everything returns 403 mentioning a loopback or private address** — you are
proxying to a destination on your laptop or LAN, which is blocked by default.
Pass `--allow-private` (CLI) or enable `gitpodProxy.allowPrivateNetworks` if
that is genuinely what you want.

**`Warning: remote port forwarding failed for listen port 8899`** — something in
the workspace already holds that port. Pick another and change both sides.

**A browser login hangs after you sign in** — most often the callback port is
already in use on your laptop, so VS Code forwarded the workspace's port to a
different local one. See [Browser-based logins](#browser-based-logins-sso-oauth-pingone).

**The tunnel drops whenever the laptop sleeps** — expected. macOS suspends
network connections on sleep. Re-run the SSH command, or use Tailscale, which
re-establishes itself.

**`502` with `ECONNREFUSED` or `ENOTFOUND`** — the proxy reached the destination
and your laptop could not. Test the same URL from a laptop terminal; the problem
is on this side, not in the tunnel.

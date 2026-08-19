'use strict';

/**
 * VS Code entry point.
 *
 * This is the path to use on a machine with no Node.js installed: the
 * extension host supplies the runtime, and because the proxy has no
 * dependencies there is nothing to install and nothing to compile.
 *
 * The manifest pins `extensionKind: ["ui"]`, so when the window is attached to
 * a remote workspace this still runs on the local machine — which is the whole
 * point, since the workspace needs *this* machine's network.
 */

const vscode = require('vscode');

const { ProxyServer } = require('./src/proxy');
const { ConfigError } = require('./src/config');
const { workspaceEnvSnippet, tunnelCommand } = require('./src/client-config');
const { InspectorPanel } = require('./inspector-panel');
const { toHar } = require('./src/har');

const PASSWORD_SECRET_KEY = 'gitpodProxy.password';

/** @type {ProxyServer | null} */
let server = null;
let output;
let statusBar;
let secrets;

function activate(context) {
  secrets = context.secrets;

  output = vscode.window.createOutputChannel('Gitpod Egress Proxy');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'gitpodProxy.showMenu';
  context.subscriptions.push(output, statusBar);

  const register = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('gitpodProxy.showInspector', () => showInspector(context));
  register('gitpodProxy.exportHar', () => exportHar());
  register('gitpodProxy.start', () => start());
  register('gitpodProxy.stop', () => stop({ announce: true }));
  register('gitpodProxy.restart', () => restart());
  register('gitpodProxy.showLog', () => output.show(true));
  register('gitpodProxy.showMenu', () => showMenu());
  register('gitpodProxy.copyWorkspaceConfig', () => copyWorkspaceConfig());
  register('gitpodProxy.copyTunnelCommand', () => copyTunnelCommand());
  register('gitpodProxy.showStats', () => showStats());
  register('gitpodProxy.setPassword', () => setPassword());
  register('gitpodProxy.clearPassword', () => clearPassword());

  // A settings change should take effect without the user restarting by hand.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gitpodProxy') && server && server.listening) {
        output.appendLine('Configuration changed — restarting the proxy.');
        restart({ silent: true });
      }
    }),
  );

  context.subscriptions.push({ dispose: () => stop({ announce: false }) });

  updateStatusBar();
  statusBar.show();

  if (vscode.workspace.getConfiguration('gitpodProxy').get('autoStart')) {
    start({ silent: true });
  }
}

function deactivate() {
  return stop({ announce: false });
}

// --------------------------------------------------------------- lifecycle

async function readSettings() {
  const settings = vscode.workspace.getConfiguration('gitpodProxy');
  const username = settings.get('username') || '';
  const password = username ? (await secrets.get(PASSWORD_SECRET_KEY)) || '' : '';

  return {
    host: settings.get('host'),
    port: settings.get('port'),
    username,
    password,
    allowPrivateNetworks: settings.get('allowPrivateNetworks'),
    allowHosts: settings.get('allowHosts'),
    denyHosts: settings.get('denyHosts'),
    allowPorts: settings.get('allowPorts'),
    logLevel: settings.get('logLevel'),
    allowUnauthenticatedRemote: settings.get('allowUnauthenticatedRemote'),
  };
}

function recorderSettings() {
  const settings = vscode.workspace.getConfiguration('gitpodProxy');
  return {
    captureBodies: settings.get('inspector.captureBodies'),
    maxBodyBytes: settings.get('inspector.maxBodyBytes'),
    maxEntries: settings.get('inspector.maxTransactions'),
  };
}

/**
 * Open the traffic inspector. Starts the proxy first if it is not running,
 * since an inspector attached to nothing is just a confusing empty table.
 */
async function showInspector(context) {
  if (!server || !server.listening) await start({ silent: true });

  const panel = InspectorPanel.show(context, () => server);
  if (server) {
    server.recorder.configure(recorderSettings());
    panel.attach(server.recorder);
  }
}

async function start(options = {}) {
  if (server && server.listening) {
    if (!options.silent) vscode.window.showInformationMessage('The proxy is already running.');
    return;
  }

  const overrides = await readSettings();
  if (overrides.username && !overrides.password) {
    const choice = await vscode.window.showWarningMessage(
      'A proxy username is configured but no password is stored.',
      'Set password',
    );
    if (choice === 'Set password') await setPassword();
    const refreshed = await readSettings();
    if (!refreshed.password) return;
    overrides.password = refreshed.password;
  }

  try {
    server = new ProxyServer(overrides, {
      // Settings are the only configuration source inside VS Code; the
      // PROXY_* environment variables belong to the CLI surface.
      env: {},
      logSink: (line) => output.appendLine(line),
    });
    server.on('error', (error) => {
      output.appendLine(`Server error: ${error.message}`);
      updateStatusBar();
    });

    const address = await server.start();
    updateStatusBar();

    // A restart builds a new server, so an open inspector has to follow it to
    // the new recorder or it silently stops receiving traffic.
    if (InspectorPanel.current) {
      server.recorder.configure(recorderSettings());
      InspectorPanel.current.attach(server.recorder);
    }

    if (!options.silent) {
      const choice = await vscode.window.showInformationMessage(
        `Proxy listening on ${address.host}:${address.port}.`,
        'Copy workspace config',
        'Show log',
      );
      if (choice === 'Copy workspace config') await copyWorkspaceConfig();
      if (choice === 'Show log') output.show(true);
    }
  } catch (error) {
    server = null;
    updateStatusBar();
    const prefix = error instanceof ConfigError ? 'Configuration error' : 'Could not start the proxy';
    output.appendLine(`${prefix}: ${error.message}`);
    const choice = await vscode.window.showErrorMessage(`${prefix}: ${error.message}`, 'Open settings');
    if (choice === 'Open settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'gitpodProxy');
    }
  }
}

async function stop(options = {}) {
  if (!server) {
    if (options.announce) vscode.window.showInformationMessage('The proxy is not running.');
    return;
  }
  await server.stop();
  server = null;
  updateStatusBar();
  if (options.announce) vscode.window.showInformationMessage('Proxy stopped.');
}

async function restart(options = {}) {
  await stop({ announce: false });
  await start({ silent: options.silent });
}

// ---------------------------------------------------------------- commands

async function showMenu() {
  const running = Boolean(server && server.listening);
  const items = running
    ? [
        { label: '$(pulse) Open traffic inspector', command: 'gitpodProxy.showInspector' },
        { label: '$(debug-stop) Stop proxy', command: 'gitpodProxy.stop' },
        { label: '$(debug-restart) Restart proxy', command: 'gitpodProxy.restart' },
        { label: '$(clippy) Copy workspace configuration', command: 'gitpodProxy.copyWorkspaceConfig' },
        { label: '$(terminal) Copy SSH tunnel command', command: 'gitpodProxy.copyTunnelCommand' },
        { label: '$(save) Export traffic as HAR', command: 'gitpodProxy.exportHar' },
        { label: '$(graph) Show traffic stats', command: 'gitpodProxy.showStats' },
        { label: '$(output) Show log', command: 'gitpodProxy.showLog' },
      ]
    : [
        { label: '$(play) Start proxy', command: 'gitpodProxy.start' },
        { label: '$(pulse) Open traffic inspector', command: 'gitpodProxy.showInspector' },
        { label: '$(key) Set proxy password', command: 'gitpodProxy.setPassword' },
        { label: '$(output) Show log', command: 'gitpodProxy.showLog' },
      ];

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Gitpod Egress Proxy' });
  if (picked) vscode.commands.executeCommand(picked.command);
}

async function copyWorkspaceConfig() {
  if (!requireRunning()) return;

  const address = server.address();
  const snippet = workspaceEnvSnippet({
    port: address.port,
    username: server.config.username,
    password: server.config.password,
  });
  await vscode.env.clipboard.writeText(`${snippet}\n`);
  vscode.window.showInformationMessage('Workspace proxy configuration copied. Paste it in the workspace terminal.');
}

async function copyTunnelCommand() {
  if (!requireRunning()) return;

  const sshTarget = vscode.workspace.getConfiguration('gitpodProxy').get('sshTarget');
  const command = tunnelCommand({ port: server.address().port, sshTarget: sshTarget || undefined });
  await vscode.env.clipboard.writeText(`${command}\n`);
  vscode.window.showInformationMessage(
    sshTarget
      ? 'SSH tunnel command copied.'
      : 'SSH tunnel command copied — replace <workspace-ssh-target> with your workspace, or set gitpodProxy.sshTarget.',
  );
}

/**
 * Write the recorded traffic to a HAR file. Opening that file in Chrome
 * DevTools, Charles, Proxyman, or Postman gives a far richer read of it than
 * this panel does, and it travels — you can hand it to someone else.
 */
async function exportHar() {
  if (!requireRunning()) return;

  const har = toHar(server.recorder.list());
  if (har.log.entries.length === 0) {
    vscode.window.showWarningMessage(
      'No completed transactions to export yet. Open the traffic inspector and let some requests through first.',
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = await vscode.window.showSaveDialog({
    title: 'Export proxy traffic as HAR',
    defaultUri: vscode.Uri.file(`proxy-traffic-${stamp}.har`),
    filters: { 'HTTP Archive': ['har'] },
  });
  if (!target) return;

  try {
    const contents = Buffer.from(`${JSON.stringify(har, null, 2)}\n`, 'utf8');
    await vscode.workspace.fs.writeFile(target, contents);
    output.appendLine(`Exported ${har.log.entries.length} entries to ${target.fsPath}`);

    const choice = await vscode.window.showInformationMessage(
      `Exported ${har.log.entries.length} entries. Drag the file into Chrome DevTools' Network panel to explore it.`,
      'Reveal file',
    );
    if (choice === 'Reveal file') vscode.commands.executeCommand('revealFileInOS', target);
  } catch (error) {
    output.appendLine(`HAR export failed: ${error.message}`);
    vscode.window.showErrorMessage(`Could not write the HAR file: ${error.message}`);
  }
}

async function showStats() {
  if (!requireRunning()) return;

  const snapshot = server.snapshot();
  output.appendLine('--- stats ---');
  output.appendLine(JSON.stringify(snapshot, null, 2));
  output.show(true);
}

async function setPassword() {
  const password = await vscode.window.showInputBox({
    prompt: 'Password for proxy authentication',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value && value.length >= 8 ? null : 'Use at least 8 characters.'),
  });
  if (!password) return;

  await secrets.store(PASSWORD_SECRET_KEY, password);
  vscode.window.showInformationMessage('Proxy password saved to the VS Code secret store.');
  if (server && server.listening) await restart({ silent: true });
}

async function clearPassword() {
  await secrets.delete(PASSWORD_SECRET_KEY);
  vscode.window.showInformationMessage('Proxy password removed.');
}

// ----------------------------------------------------------------- helpers

function requireRunning() {
  if (server && server.listening) return true;
  vscode.window.showWarningMessage('Start the proxy first.');
  return false;
}

function updateStatusBar() {
  if (!statusBar) return;

  if (server && server.listening) {
    const address = server.address();
    const locked = server.config.authEnabled ? '$(lock)' : '$(unlock)';
    statusBar.text = `$(radio-tower) Proxy ${address.port} ${locked}`;
    statusBar.tooltip = server.config.authEnabled
      ? `Egress proxy on ${address.host}:${address.port}, password protected`
      : `Egress proxy on ${address.host}:${address.port} — no password set`;
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = '$(circle-slash) Proxy off';
    statusBar.tooltip = 'Gitpod egress proxy is stopped';
    statusBar.backgroundColor = undefined;
  }
}

module.exports = { activate, deactivate };

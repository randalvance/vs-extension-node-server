'use strict';

/**
 * The inspector's VS Code half: owns the webview panel and bridges it to the
 * proxy's TrafficRecorder.
 *
 * Updates are coalesced on a short timer. A single `npm install` can produce
 * hundreds of transactions per second, and posting a message per event would
 * spend more time in serialization than in the proxy.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

const vscode = require('vscode');

const { toSummary } = require('./src/traffic-recorder');
const { buildDetail } = require('./src/transaction-detail');

const VIEW_TYPE = 'gitpodProxy.inspector';
const FLUSH_INTERVAL_MS = 100;

class InspectorPanel {
  /**
   * Reveal the existing panel, or create one. Only ever one — a second copy
   * would double the recorder subscriptions for no benefit.
   */
  static show(context, getServer) {
    if (InspectorPanel.current) {
      InspectorPanel.current._panel.reveal(vscode.ViewColumn.Active);
      return InspectorPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Proxy Traffic',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    InspectorPanel.current = new InspectorPanel(panel, context, getServer);
    return InspectorPanel.current;
  }

  constructor(panel, context, getServer) {
    this._panel = panel;
    this._context = context;
    this._getServer = getServer;
    this._disposables = [];
    this._recorderSubscriptions = [];
    this._pendingIds = new Set();
    this._pendingEvictions = new Set();
    this._flushTimer = null;
    this._boundRecorder = null;

    this._panel.webview.html = this._renderHtml();

    this._panel.webview.onDidReceiveMessage(
      (message) => this._onMessage(message),
      null,
      this._disposables,
    );
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  /**
   * Point the panel at a recorder. Called when the panel opens and again
   * whenever the proxy restarts, since a restart builds a new server.
   */
  attach(recorder) {
    if (this._boundRecorder === recorder) return;
    this._detachRecorder();
    this._boundRecorder = recorder;
    if (!recorder) return;

    recorder.setEnabled(true);

    const onBegin = (record) => this._queue(record.id);
    const onUpdate = (record) => this._queue(record.id);
    const onEvict = (id) => {
      this._pendingIds.delete(id);
      this._pendingEvictions.add(id);
      this._scheduleFlush();
    };
    const onCleared = () => this._post({ type: 'cleared' });

    recorder.on('begin', onBegin);
    recorder.on('update', onUpdate);
    recorder.on('evict', onEvict);
    recorder.on('cleared', onCleared);
    this._recorderSubscriptions.push(() => {
      recorder.off('begin', onBegin);
      recorder.off('update', onUpdate);
      recorder.off('evict', onEvict);
      recorder.off('cleared', onCleared);
    });

    this._sendReset();
  }

  dispose() {
    this._detachRecorder();
    if (this._flushTimer) clearTimeout(this._flushTimer);
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
    this._panel.dispose();
    if (InspectorPanel.current === this) InspectorPanel.current = null;
  }

  // ----------------------------------------------------------------- wiring

  _detachRecorder() {
    for (const unsubscribe of this._recorderSubscriptions) unsubscribe();
    this._recorderSubscriptions = [];
    this._boundRecorder = null;
  }

  _recorder() {
    const server = this._getServer();
    return server ? server.recorder : null;
  }

  _onMessage(message) {
    const recorder = this._boundRecorder;

    switch (message.type) {
      case 'ready':
        this.attach(this._recorder());
        this._sendState();
        this._sendReset();
        break;
      case 'select': {
        if (!recorder) return;
        const detail = buildDetail(recorder.get(message.id));
        this._post({ type: 'detail', detail });
        break;
      }
      case 'clear':
        if (recorder) recorder.clear();
        break;
      case 'setRecording':
        if (recorder) recorder.setEnabled(Boolean(message.value));
        this._sendState();
        break;
      default:
        break;
    }
  }

  _queue(id) {
    this._pendingIds.add(id);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, FLUSH_INTERVAL_MS);
  }

  _flush() {
    const recorder = this._boundRecorder;
    if (!recorder) return;

    if (this._pendingEvictions.size > 0) {
      this._post({ type: 'evict', ids: [...this._pendingEvictions] });
      this._pendingEvictions.clear();
    }

    if (this._pendingIds.size === 0) return;
    const items = [...this._pendingIds]
      .map((id) => recorder.get(id))
      .filter(Boolean)
      .map(toSummary);
    this._pendingIds.clear();

    if (items.length > 0) this._post({ type: 'upsert', items });
  }

  _sendReset() {
    const recorder = this._boundRecorder;
    this._post({ type: 'reset', items: recorder ? recorder.list().map(toSummary) : [] });
  }

  _sendState() {
    const recorder = this._boundRecorder;
    this._post({ type: 'state', recording: recorder ? recorder.enabled : false });
  }

  _post(message) {
    // Rejects once the panel is disposed, which races with in-flight timers.
    this._panel.webview.postMessage(message).then(undefined, () => {});
  }

  _renderHtml() {
    const { webview } = this._panel;
    const mediaUri = (name) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', name));

    const htmlPath = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'inspector.html');
    const template = fs.readFileSync(htmlPath.fsPath, 'utf8');

    return template
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{nonce}}', crypto.randomBytes(16).toString('base64'))
      .replaceAll('{{styleUri}}', mediaUri('inspector.css').toString())
      .replaceAll('{{scriptUri}}', mediaUri('inspector.js').toString());
  }
}

InspectorPanel.current = null;

module.exports = { InspectorPanel, VIEW_TYPE };

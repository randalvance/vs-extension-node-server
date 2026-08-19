'use strict';

/*
 * Inspector webview.
 *
 * Everything rendered here — header names, header values, bodies — is content
 * the proxy pulled off the network. It is built with createElement and
 * textContent throughout, never innerHTML, so a response body cannot inject
 * markup into the panel.
 */

(function () {
  const vscode = acquireVsCodeApi();

  const rowsBody = document.getElementById('rows');
  const emptyList = document.getElementById('empty');
  const detailEmpty = document.getElementById('detail-empty');
  const detailBox = document.getElementById('detail');
  const detailMethod = document.getElementById('detail-method');
  const detailUrl = document.getElementById('detail-url');
  const filterInput = document.getElementById('filter');
  const errorsOnly = document.getElementById('errors-only');
  const recordButton = document.getElementById('record');
  const recordLabel = document.getElementById('record-label');
  const clearButton = document.getElementById('clear');
  const counts = document.getElementById('counts');
  const splitter = document.getElementById('splitter');
  const detailPane = document.querySelector('.detail-pane');
  const listPane = document.querySelector('.list-pane');

  /** @type {Map<number, {summary: object, row: HTMLTableRowElement}>} */
  const entries = new Map();
  let selectedId = null;
  let activeTab = 'headers';
  let recording = true;

  // ------------------------------------------------------------- formatting

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function statusText(summary) {
    if (summary.state === 'pending') return '···';
    if (summary.state === 'blocked') return String(summary.statusCode || 'blocked');
    if (summary.state === 'error') return summary.statusCode ? String(summary.statusCode) : 'failed';
    if (summary.kind === 'connect') return '200';
    return summary.statusCode === null ? '—' : String(summary.statusCode);
  }

  function statusClass(summary) {
    if (summary.state === 'pending') return 'status-pending';
    if (summary.state === 'blocked' || summary.state === 'error') return 'status-error';
    if (summary.kind === 'connect') return 'status-tunnel';

    const code = summary.statusCode;
    if (code === null) return 'status-pending';
    if (code >= 500 || code >= 400) return 'status-error';
    if (code >= 300) return 'status-redirect';
    return 'status-ok';
  }

  function displayPath(summary) {
    if (summary.kind === 'connect') return `CONNECT ${summary.host}:${summary.port}`;
    return summary.path || '/';
  }

  // ---------------------------------------------------------------- filtering

  function matchesFilter(summary) {
    if (errorsOnly.checked) {
      const failed =
        summary.state === 'blocked' ||
        summary.state === 'error' ||
        (typeof summary.statusCode === 'number' && summary.statusCode >= 400);
      if (!failed) return false;
    }

    const needle = filterInput.value.trim().toLowerCase();
    if (!needle) return true;

    return [summary.method, summary.host, summary.path, summary.url, statusText(summary)]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle));
  }

  function applyFilter() {
    let visible = 0;
    for (const entry of entries.values()) {
      const shown = matchesFilter(entry.summary);
      entry.row.hidden = !shown;
      if (shown) visible += 1;
    }
    emptyList.hidden = entries.size > 0 && visible > 0;
    if (entries.size > 0 && visible === 0) {
      emptyList.textContent = 'No requests match the current filter.';
      emptyList.hidden = false;
    } else if (entries.size === 0) {
      emptyList.textContent = 'No traffic yet. Requests appear here as the workspace makes them.';
      emptyList.hidden = false;
    }
    updateCounts(visible);
  }

  function updateCounts(visible) {
    const total = entries.size;
    const shown = visible === undefined ? [...entries.values()].filter((e) => !e.row.hidden).length : visible;
    counts.textContent = total === shown ? `${total} requests` : `${shown} of ${total} requests`;
  }

  // ------------------------------------------------------------------ rows

  function cell(row, text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function buildRow(summary) {
    const row = document.createElement('tr');
    row.dataset.id = String(summary.id);
    cell(row, '', 'col-status');
    cell(row, '', 'col-method method');
    cell(row, '', 'col-host');
    cell(row, '', 'col-path');
    cell(row, '', 'col-size');
    cell(row, '', 'col-time');
    row.addEventListener('click', () => select(summary.id));
    return row;
  }

  function paintRow(row, summary) {
    const cells = row.children;
    cells[0].textContent = statusText(summary);
    cells[0].className = `col-status ${statusClass(summary)}`;
    cells[1].textContent = summary.method || '';
    cells[2].textContent = summary.host || '';
    cells[3].textContent = displayPath(summary);
    cells[3].title = summary.url || '';
    // A tunnel has no "response" — both directions are just traffic, so the
    // useful number is the total that crossed it.
    cells[4].textContent =
      summary.kind === 'connect'
        ? formatBytes((summary.requestBytes || 0) + (summary.responseBytes || 0))
        : formatBytes(summary.responseBytes);
    cells[5].textContent = formatDuration(summary.durationMs);
  }

  function upsert(summary) {
    let entry = entries.get(summary.id);
    if (!entry) {
      const row = buildRow(summary);
      entry = { summary, row };
      entries.set(summary.id, entry);

      // Keep following new traffic only when already parked at the bottom.
      const pinned = listPane.scrollTop + listPane.clientHeight >= listPane.scrollHeight - 24;
      rowsBody.appendChild(row);
      if (pinned) listPane.scrollTop = listPane.scrollHeight;
    } else {
      entry.summary = summary;
    }

    paintRow(entry.row, summary);
    entry.row.classList.toggle('selected', summary.id === selectedId);
    entry.row.hidden = !matchesFilter(summary);
  }

  function select(id) {
    selectedId = id;
    for (const entry of entries.values()) {
      entry.row.classList.toggle('selected', entry.summary.id === id);
    }
    vscode.postMessage({ type: 'select', id });
  }

  // --------------------------------------------------------------- detail

  function renderDetail(detail) {
    detailEmpty.hidden = true;
    detailBox.hidden = false;

    detailMethod.textContent = detail.method || '';
    detailMethod.className = `method ${statusClass(detail)}`;
    detailUrl.textContent = detail.url || '';

    renderHeadersPanel(detail);
    renderBodyPanel('request', detail.requestBody, detail);
    renderBodyPanel('response', detail.responseBody, detail);
    renderTimingPanel(detail);
  }

  function panelFor(name) {
    const panel = document.querySelector(`.panel[data-panel="${name}"]`);
    panel.replaceChildren();
    return panel;
  }

  function addNote(parent, text, variant) {
    const note = document.createElement('p');
    note.className = variant ? `note ${variant}` : 'note';
    note.textContent = text;
    parent.appendChild(note);
    return note;
  }

  function addHeading(parent, text) {
    const heading = document.createElement('h3');
    heading.textContent = text;
    parent.appendChild(heading);
  }

  function addDefinitionList(parent, pairs) {
    const list = document.createElement('dl');
    list.className = 'headers';
    for (const [name, value] of pairs) {
      const term = document.createElement('dt');
      term.textContent = name;
      const definition = document.createElement('dd');
      definition.textContent = Array.isArray(value) ? value.join('\n') : String(value);
      list.appendChild(term);
      list.appendChild(definition);
    }
    parent.appendChild(list);
  }

  function renderHeadersPanel(detail) {
    const panel = panelFor('headers');

    if (detail.blockedReason) addNote(panel, detail.blockedReason, 'warning');
    if (detail.error) addNote(panel, detail.error, 'error');

    addHeading(panel, 'General');
    addDefinitionList(panel, [
      ['URL', detail.url || ''],
      ['Method', detail.method || ''],
      ['Status', `${statusText(detail)} ${detail.statusMessage || ''}`.trim()],
      ['Remote address', detail.remoteAddress || 'not connected'],
      ['Client', detail.clientAddress || ''],
      ['Protocol', detail.kind === 'connect' ? 'TLS tunnel (CONNECT)' : `HTTP/${detail.httpVersion || '1.1'}`],
    ]);

    addHeading(panel, 'Request headers');
    const requestPairs = Object.entries(detail.requestHeaders || {});
    if (requestPairs.length) addDefinitionList(panel, requestPairs);
    else addNote(panel, 'No request headers were captured.');

    addHeading(panel, 'Response headers');
    const responsePairs = Object.entries(detail.responseHeaders || {});
    if (responsePairs.length) addDefinitionList(panel, responsePairs);
    else if (detail.kind === 'connect') addNote(panel, 'A tunnel has no response headers beyond the 200.');
    else addNote(panel, 'No response headers — the request did not reach a server.');
  }

  function renderBodyPanel(which, body, detail) {
    const panel = panelFor(which);

    if (detail.tunnelNote) {
      addNote(panel, detail.tunnelNote, 'warning');
      return;
    }
    if (!body || body.kind === 'empty') {
      addNote(panel, `No ${which} body.`);
      return;
    }
    if (body.kind === 'not-captured') {
      addNote(panel, `${body.note} ${formatBytes(body.size)} passed through.`);
      return;
    }

    const summaryBits = [formatBytes(body.size)];
    if (body.note) summaryBits.push(body.note);
    if (body.truncated) summaryBits.push(`truncated to the first ${formatBytes(body.size)} captured`);
    addNote(panel, summaryBits.join(' · '));

    const pre = document.createElement('pre');
    pre.className = 'body';
    pre.textContent = body.text || '';
    panel.appendChild(pre);
  }

  function renderTimingPanel(detail) {
    const panel = panelFor('timing');
    const timing = detail.timing || {};

    const phases = [
      ['Blocked', timing.blockedMs, 'blocked', 'Policy checks, DNS, and connecting'],
      ['Waiting', timing.waitingMs, 'waiting', 'Time to first response byte'],
      ['Download', timing.downloadMs, 'download', 'Receiving the response body'],
    ].filter(([, value]) => value !== null && value !== undefined);

    if (phases.length === 0) {
      addNote(panel, 'No timing breakdown — this request never reached a server.');
    } else {
      const longest = Math.max(...phases.map(([, value]) => value), 1);
      for (const [label, value, variant, description] of phases) {
        const rowEl = document.createElement('div');
        rowEl.className = 'timing-row';
        rowEl.title = description;

        const labelEl = document.createElement('span');
        labelEl.className = 'timing-label';
        labelEl.textContent = label;

        const track = document.createElement('div');
        track.className = 'timing-track';
        const bar = document.createElement('div');
        bar.className = `timing-bar ${variant}`;
        bar.style.width = `${Math.max(2, (value / longest) * 100)}%`;
        track.appendChild(bar);

        const valueEl = document.createElement('span');
        valueEl.className = 'timing-value';
        valueEl.textContent = formatDuration(value);

        rowEl.append(labelEl, track, valueEl);
        panel.appendChild(rowEl);
      }
    }

    const tunnel = detail.kind === 'connect';
    addHeading(panel, 'Totals');
    addDefinitionList(panel, [
      ['Total', formatDuration(timing.totalMs)],
      ['Started', new Date(timing.startedAt).toLocaleTimeString()],
      [tunnel ? 'Sent' : 'Request size', formatBytes(detail.requestBytes)],
      [tunnel ? 'Received' : 'Response size', formatBytes(detail.responseBytes)],
    ]);
  }

  // ------------------------------------------------------------------ tabs

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('active', other === tab);
      }
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('active', panel.dataset.panel === activeTab);
      }
    });
  }

  // -------------------------------------------------------------- splitter

  splitter.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = detailPane.getBoundingClientRect().width;

    const onMove = (moveEvent) => {
      const width = Math.min(
        Math.max(startWidth - (moveEvent.clientX - startX), 280),
        window.innerWidth - 240,
      );
      detailPane.style.flexBasis = `${width}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ------------------------------------------------------------- toolbar

  recordButton.addEventListener('click', () => {
    recording = !recording;
    vscode.postMessage({ type: 'setRecording', value: recording });
    paintRecordButton();
  });

  function paintRecordButton() {
    recordButton.classList.toggle('paused', !recording);
    recordLabel.textContent = recording ? 'Recording' : 'Paused';
  }

  clearButton.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  filterInput.addEventListener('input', applyFilter);
  errorsOnly.addEventListener('change', applyFilter);

  function resetList() {
    entries.clear();
    rowsBody.replaceChildren();
    selectedId = null;
    detailBox.hidden = true;
    detailEmpty.hidden = false;
    applyFilter();
  }

  // -------------------------------------------------------------- messages

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        recording = message.recording;
        paintRecordButton();
        break;
      case 'reset':
        resetList();
        for (const summary of message.items) upsert(summary);
        applyFilter();
        break;
      case 'upsert':
        for (const summary of message.items) upsert(summary);
        applyFilter();
        break;
      case 'detail':
        if (message.detail && message.detail.id === selectedId) renderDetail(message.detail);
        break;
      case 'evict':
        for (const id of message.ids) {
          const entry = entries.get(id);
          if (entry) {
            entry.row.remove();
            entries.delete(id);
          }
        }
        applyFilter();
        break;
      case 'cleared':
        resetList();
        break;
      default:
        break;
    }
  });

  paintRecordButton();
  applyFilter();
  vscode.postMessage({ type: 'ready' });
})();

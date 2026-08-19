'use strict';

/**
 * Assembles the full view of one transaction for the inspector's detail pane:
 * headers, decoded bodies, and a timing breakdown.
 *
 * Built on demand for the selected row only. Summaries carry the list; bodies
 * would otherwise push megabytes into the webview for traffic nobody opened.
 */

const { previewBody } = require('./body-preview');
const { toSummary } = require('./traffic-recorder');

/** Why a tunnelled transaction has no body to show. */
const TLS_EXPLANATION =
  'This is a CONNECT tunnel. Everything after the handshake is TLS-encrypted, ' +
  'so the proxy can see the destination, timing, and byte counts, but not the ' +
  'headers or body inside. Reading those would require terminating TLS with a ' +
  'certificate authority trusted by the workspace.';

function buildDetail(record) {
  if (!record) return null;

  const isTunnel = record.kind === 'connect';

  return {
    ...toSummary(record),
    clientAddress: record.clientAddress,
    remoteAddress: record.remoteAddress,
    httpVersion: record.request.httpVersion,
    requestHeaders: record.request.headers,
    responseHeaders: record.response.headers,
    error: record.error,
    blockedReason: record.blockedReason,
    tunnelNote: isTunnel ? TLS_EXPLANATION : null,
    requestBody: isTunnel ? null : previewBody(record.request, record.request.headers),
    responseBody: isTunnel ? null : previewBody(record.response, record.response.headers),
    bytesUp: record.bytesUp,
    bytesDown: record.bytesDown,
    timing: buildTiming(record),
  };
}

/**
 * Phase durations, each null when the phase never happened — a blocked request
 * has no connect phase, and a pending one has no total.
 */
function buildTiming(record) {
  const { startedAt, connectedAt, firstByteAt, completedAt } = record.timings;

  return {
    startedAt,
    connectedAt,
    firstByteAt,
    completedAt,
    // Time spent on policy checks and DNS before a socket existed.
    blockedMs: connectedAt ? connectedAt - startedAt : null,
    // Connect to first response byte: the upstream's own latency.
    waitingMs: connectedAt && firstByteAt ? firstByteAt - connectedAt : null,
    // First byte to last: how long the body took to arrive.
    downloadMs: firstByteAt && completedAt ? completedAt - firstByteAt : null,
    totalMs: completedAt ? completedAt - startedAt : null,
  };
}

module.exports = { buildDetail, buildTiming, TLS_EXPLANATION };

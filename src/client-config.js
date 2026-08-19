'use strict';

/**
 * Generates the snippet you paste into the Gitpod/Ona workspace so its tools
 * route egress through this proxy. Shared by the CLI banner and the VS Code
 * "Copy workspace configuration" command so the two never disagree.
 */

/**
 * @param {object} options
 * @param {number} options.port      Port the workspace will dial (tunnel-local).
 * @param {string} [options.host]    Host the workspace will dial. Default 127.0.0.1,
 *                                   which is what an SSH reverse tunnel produces.
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {string[]} [options.noProxy] Extra hosts the workspace should reach directly.
 */
function workspaceEnvSnippet(options) {
  const host = options.host || '127.0.0.1';
  const credentials =
    options.username && options.password
      ? `${encodeURIComponent(options.username)}:${encodeURIComponent(options.password)}@`
      : '';
  const url = `http://${credentials}${host}:${options.port}`;

  const noProxy = [
    'localhost',
    '127.0.0.1',
    '::1',
    '.internal',
    ...(options.noProxy || []),
  ].join(',');

  return [
    `export HTTP_PROXY=${url}`,
    `export HTTPS_PROXY=${url}`,
    `export http_proxy=${url}`,
    `export https_proxy=${url}`,
    `export NO_PROXY=${noProxy}`,
    `export no_proxy=${noProxy}`,
  ].join('\n');
}

/** The equivalent reverse-tunnel command to run from the host laptop. */
function tunnelCommand(options) {
  const port = options.port;
  const target = options.sshTarget || '<workspace-ssh-target>';
  return `ssh -N -R ${port}:127.0.0.1:${port} ${target}`;
}

module.exports = { workspaceEnvSnippet, tunnelCommand };

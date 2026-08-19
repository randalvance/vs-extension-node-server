#!/usr/bin/env node
'use strict';

/**
 * Standalone entry point: `node server.js [options]`.
 * The VS Code extension host uses extension.js instead; both drive src/proxy.js.
 */

const { main } = require('./src/cli');

main().then(
  (code) => {
    if (typeof code === 'number') process.exit(code);
  },
  (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  },
);

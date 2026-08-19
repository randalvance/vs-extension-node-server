'use strict';

/**
 * A level-filtered logger that writes through a caller-supplied sink, so the
 * same core can log to stdout from the CLI or to an Output channel in VS Code.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function createLogger(options = {}) {
  const sink = options.sink || ((line) => process.stdout.write(`${line}\n`));
  let threshold = LEVELS[options.level] ?? LEVELS.info;

  function emit(level, message) {
    if (LEVELS[level] > threshold) return;
    const stamp = new Date().toISOString();
    sink(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}`, level);
  }

  return {
    get level() {
      return Object.keys(LEVELS).find((name) => LEVELS[name] === threshold);
    },
    setLevel(level) {
      if (level in LEVELS) threshold = LEVELS[level];
    },
    error: (message) => emit('error', message),
    warn: (message) => emit('warn', message),
    info: (message) => emit('info', message),
    debug: (message) => emit('debug', message),
  };
}

module.exports = { createLogger, LEVELS };

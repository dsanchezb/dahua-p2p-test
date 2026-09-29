'use strict';

const net = require('net');

/**
 * Find a free TCP port on 127.0.0.1 within [min, max].
 * Not perfectly race-free (port could be taken between the check and the
 * caller actually binding it), but good enough for a single-host PoC: the
 * caller should treat "address already in use" from the child process as a
 * retryable error.
 */
function checkPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function findFreePort(min = 20000, max = 40000, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    const port = Math.floor(Math.random() * (max - min + 1)) + min;
    // eslint-disable-next-line no-await-in-loop
    if (await checkPortFree(port)) {
      return port;
    }
  }
  throw new Error('Could not find a free port');
}

module.exports = { findFreePort };

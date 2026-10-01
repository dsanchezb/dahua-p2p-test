'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DH_P2P_BIN = path.join(__dirname, '..', 'vendor', 'dh-p2p', 'target', 'release', 'dh-p2p');

const READY_MARKER = 'Ready to connect';
const AUTH_FAIL_MARKERS = [
  'requires authentication',
  'Error response: 403 Forbidden',
];

function dhP2pBinaryExists() {
  return fs.existsSync(DH_P2P_BIN);
}

/**
 * Spawns the vendored dh-p2p --relay binary, tunneling the device's RTSP
 * port (554) to 127.0.0.1:rtspPort, via the Dahua P2P/PTCP protocol.
 *
 * Shared by sessionManager.js (single live view) and channelScan.js
 * (channel/stream discovery) — both just need "a local RTSP proxy for this
 * serial", the only difference is what they do with it afterwards.
 *
 * Returns `{ proc, ready }`:
 *   - `proc` is the spawned child process (or `null` if the binary is
 *     missing, in which case `ready` is already a rejected promise).
 *   - `ready` resolves once the tunnel reports readiness, or rejects if
 *     startup fails/times out/the device refuses the channel.
 *
 * The process keeps running and `onLog` keeps being called after `ready`
 * settles (including a final "process exited" line). Callers that need to
 * react to the tunnel dying *after* it was ready (e.g. to flag a live
 * session as broken) should add their own `proc.on('exit', ...)` listener;
 * this module does not remove or replace listeners added by callers.
 */
function startDhP2pTunnel({ serial, cloud, rtspPort, onLog = () => {}, readyTimeoutMs = 25_000 }) {
  if (!dhP2pBinaryExists()) {
    return {
      proc: null,
      ready: Promise.reject(new Error(
        `dh-p2p binary not found at ${DH_P2P_BIN}. Run "npm run build:dhp2p" first.`
      )),
    };
  }

  const args = ['--relay', '-p', `127.0.0.1:${rtspPort}:554`];
  if (cloud && cloud !== 'easy4ip') {
    // Note: the vendored Rust CLI does not currently expose --cloud; this
    // is reserved for when/if upstream adds it. easy4ip is the default and
    // covers Dahua/derived devices; Amcrest devices are out of scope here.
    onLog('dh-p2p', `warning: cloud override "${cloud}" requested but the Rust binary only supports easy4ip; continuing with easy4ip.`);
  }
  args.push(serial);

  const proc = spawn(DH_P2P_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  if (process.env.DHP2P_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(`[debug] spawned dh-p2p pid=${proc.pid} args=${JSON.stringify(args)}`);
  }

  const ready = new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for the P2P tunnel to reach the device (no response after 25s). The device may be offline, the serial may be wrong, or it may not be reachable through this relay.'));
      }
    }, readyTimeoutMs);

    const onData = (source) => (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        onLog(source, line);
        if (process.env.DHP2P_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(`[debug:${source}] ${line}`);
        }

        if (!settled) {
          if (line.includes(READY_MARKER)) {
            settled = true;
            clearTimeout(timer);
            resolve();
          } else if (AUTH_FAIL_MARKERS.some((m) => line.includes(m))) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Device rejected the P2P channel setup: ${line.trim()}`));
          } else if (/^Error:/.test(line.trim())) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(line.trim()));
          }
        }
      }
    };

    proc.stdout.on('data', onData('dh-p2p'));
    proc.stderr.on('data', onData('dh-p2p:err'));

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.on('exit', (code, signal) => {
      onLog('dh-p2p', `process exited (code=${code}, signal=${signal})`);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`dh-p2p exited before the tunnel was ready (code=${code}, signal=${signal})`));
      }
    });
  });

  return { proc, ready };
}

/**
 * Sends SIGTERM, then escalates to SIGKILL after a grace period if the
 * process is still alive — a plain SIGTERM is not guaranteed to be acted on
 * promptly (or at all) by every process state, and a stuck dh-p2p process
 * left running is exactly the kind of leak that would otherwise go
 * unnoticed (it holds no listening port once past its own startup).
 */
function stopDhP2pTunnel(proc, graceMs = 2000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, graceMs);
  // Don't let this timer keep the event loop alive on its own if everything
  // else has already shut down (e.g. during process exit cleanup).
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  DH_P2P_BIN,
  dhP2pBinaryExists,
  startDhP2pTunnel,
  stopDhP2pTunnel,
};

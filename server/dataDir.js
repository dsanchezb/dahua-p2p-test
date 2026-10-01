'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Root directory for all runtime data this app writes to disk (HLS
 * segments for live sessions, channel-scan thumbnails, and continuous
 * recordings). Defaults to a `var/` directory next to the app itself,
 * overridable via the DATA_DIR env var.
 *
 * Deliberately NOT os.tmpdir(): when this app runs under a systemd unit
 * with PrivateTmp=true (as it does in this project's own deployment),
 * /tmp is a private, size-limited mount namespaced to the service and
 * disconnected from the real host disk — os.statfs() on it then reports
 * that tiny private mount's capacity, not the actual free space on the
 * disk recordings are meant to fill. Using a directory under the app's own
 * install path keeps disk-space accounting (used by the continuous
 * recorder's quota/space-remaining logic) meaningful, and both ReadWritePaths
 * in the systemd unit and `ProtectSystem=strict` need to allow writes here.
 */
const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'var');

function ensureDataDir(name) {
  const dir = path.join(DATA_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Checks that DATA_ROOT is actually writable and lives on the real disk
 * (not an unexpectedly tiny mount) by writing+deleting a small probe file.
 * Called once at startup so a misconfiguration surfaces immediately as a
 * clear log line instead of silently-wrong "disk full" quota behavior
 * discovered later.
 */
function verifyWritable() {
  const probe = path.join(DATA_ROOT, `.write-test-${process.pid}`);
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[dataDir] WARNING: ${DATA_ROOT} is not writable: ${err.message}. Set DATA_DIR to a writable path (and, if running under systemd with ProtectSystem/ReadWritePaths, add it there too).`);
    return false;
  }
}

// os.tmpdir() is kept as a last-ditch fallback purely so the process
// doesn't crash outright if DATA_ROOT truly can't be created (e.g. a
// read-only root filesystem) — recordings' space accounting will be wrong
// in that case, but live view and channel scans will still mostly work.
function resolveDataRoot() {
  if (verifyWritable()) return DATA_ROOT;
  const fallback = path.join(os.tmpdir(), 'dahua-p2p-data-fallback');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const RESOLVED_ROOT = resolveDataRoot();

module.exports = {
  DATA_ROOT: RESOLVED_ROOT,
  ensureDataDir: (name) => {
    const dir = path.join(RESOLVED_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
};

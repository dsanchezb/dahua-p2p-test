'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { findFreePort } = require('./ports');
const { startDhP2pTunnel, stopDhP2pTunnel } = require('./dhTunnel');
const { buildRtspUrl } = require('./rtsp');
const { ensureDataDir } = require('./dataDir');

const THUMB_ROOT = ensureDataDir('thumbnails');

// Subtypes probed per channel. 0 = main/HD stream, 1 = sub/lower-bitrate
// stream — most Dahua devices expose both per channel, but some only expose
// one, which is exactly the kind of thing this scan is meant to discover.
const SUBTYPES = [0, 1];

// Per-frame-capture timeout. ffmpeg is given a shorter RTSP-level timeout
// (see captureFrame) so it normally gives up on its own well before this;
// this is just the hard backstop in case the process hangs for an unrelated
// reason (e.g. the PTCP tunnel itself wedges).
const CAPTURE_TIMEOUT_MS = 12_000;

// Stop scanning further channels after this many consecutive channels with
// no stream on either subtype, once at least MIN_BEFORE_EARLY_STOP channels
// have been checked. Avoids spending minutes scanning channels 5-16 on a
// 4-channel NVR; a couple of transient misses from P2P flakiness alone
// shouldn't trigger it.
const CONSECUTIVE_EMPTY_TO_STOP = 3;
const MIN_BEFORE_EARLY_STOP = 4;

fs.mkdirSync(THUMB_ROOT, { recursive: true });

/** @type {Map<string, Scan>} */
const scans = new Map();

class Scan {
  constructor({ serial, username, password, cloud, maxChannels }) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.serial = serial;
    this.username = username;
    this.password = password;
    this.cloud = cloud;
    this.maxChannels = maxChannels;

    this.status = 'starting'; // starting -> scanning -> done/error/stopped
    this.error = null;
    this.rtspPort = null;
    this.dhProc = null;
    this.currentProbeProc = null;
    this.cancelled = false;
    this.earlyStopped = false;
    this.progress = 0; // highest channel number fully probed so far

    /** @type {Map<number, object>} */
    this.channels = new Map();

    this.thumbDir = path.join(THUMB_ROOT, this.id);
    this.log = [];
    this.createdAt = Date.now();
  }

  appendLog(source, line) {
    this.log.push(`[${source}] ${line}`);
    if (this.log.length > 500) this.log.shift();
  }

  toJSON() {
    const channels = Array.from(this.channels.values())
      .sort((a, b) => a.channel - b.channel)
      .map((c) => ({
        channel: c.channel,
        state: c.state,
        available: c.available,
        subtypes: { ...c.subtypes },
        thumbnailUrl: c.thumbnailUrl,
        thumbnailSubtype: c.thumbnailSubtype ?? null,
      }));

    return {
      id: this.id,
      status: this.status,
      error: this.error,
      serial: this.serial,
      maxChannels: this.maxChannels,
      progress: this.progress,
      earlyStopped: this.earlyStopped,
      createdAt: this.createdAt,
      channels,
    };
  }
}

function setStatus(scan, status, error) {
  scan.status = status;
  if (error) scan.error = String(error);
}

/**
 * Spawns ffmpeg to pull exactly one frame from the given channel/subtype via
 * the local RTSP proxy and save it as a scaled-down JPEG. Resolves `true` on
 * a usable image, `false` on any failure (stream doesn't exist, auth
 * rejected, timeout, etc.) — callers don't need to distinguish *why* a
 * channel/subtype is unavailable, only that it is.
 */
function captureFrame({ scan, username, password, rtspPort, channel, subtype, outPath }) {
  return new Promise((resolve) => {
    const rtspUrl = buildRtspUrl({ username, password, rtspPort, channel, subtype });

    const args = [
      '-rtsp_transport', 'tcp',
      '-timeout', '8000000', // 8s socket-level timeout, in microseconds
      '-i', rtspUrl,
      '-frames:v', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '5',
      '-y',
      outPath,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    scan.currentProbeProc = proc;

    let settled = false;

    const finish = (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (scan.currentProbeProc === proc) scan.currentProbeProc = null;

      let ok = success;
      if (ok) {
        try {
          const stat = fs.statSync(outPath);
          if (!stat.isFile() || stat.size < 300) ok = false;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        fs.unlink(outPath, () => {});
      }
      resolve(ok);
    };

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      finish(false);
    }, CAPTURE_TIMEOUT_MS);

    // Drain stderr without logging every line (one probe can produce a lot
    // of noise and we run up to maxChannels * 2 of these per scan); the
    // scan loop logs a one-line summary per channel instead.
    proc.stderr.on('data', () => {});

    proc.on('exit', (code) => finish(code === 0));
    proc.on('error', () => finish(false));
  });
}

async function runScanLoop(scan) {
  fs.mkdirSync(scan.thumbDir, { recursive: true });

  let consecutiveEmpty = 0;

  for (let channel = 1; channel <= scan.maxChannels; channel++) {
    if (scan.cancelled || scan.status !== 'scanning') break;

    const entry = {
      channel,
      state: 'probing',
      available: null,
      subtypes: { 0: null, 1: null },
      thumbnailUrl: null,
      thumbnailSubtype: null,
    };
    scan.channels.set(channel, entry);

    for (const subtype of SUBTYPES) {
      if (scan.cancelled || scan.status !== 'scanning') break;

      const fileName = `ch${channel}_sub${subtype}.jpg`;
      const outPath = path.join(scan.thumbDir, fileName);

      // eslint-disable-next-line no-await-in-loop
      const ok = await captureFrame({
        scan,
        username: scan.username,
        password: scan.password,
        rtspPort: scan.rtspPort,
        channel,
        subtype,
        outPath,
      });

      entry.subtypes[subtype] = ok;
      if (ok && !entry.thumbnailUrl) {
        entry.thumbnailUrl = `/thumbnails/${scan.id}/${fileName}`;
        entry.thumbnailSubtype = subtype;
      }
    }

    entry.available = Boolean(entry.subtypes[0] || entry.subtypes[1]);
    entry.state = 'done';
    scan.progress = channel;

    scan.appendLog('scan', `channel ${channel}: ${
      entry.available
        ? `available (subtype 0: ${entry.subtypes[0] ? 'yes' : 'no'}, subtype 1: ${entry.subtypes[1] ? 'yes' : 'no'})`
        : 'no stream on either subtype'
    }`);

    consecutiveEmpty = entry.available ? 0 : consecutiveEmpty + 1;

    if (consecutiveEmpty >= CONSECUTIVE_EMPTY_TO_STOP && channel >= MIN_BEFORE_EARLY_STOP) {
      scan.earlyStopped = true;
      scan.appendLog('scan', `stopping early after ${consecutiveEmpty} consecutive empty channels`);
      break;
    }
  }

  if (scan.cancelled) {
    setStatus(scan, 'stopped');
  } else if (scan.status === 'scanning') {
    setStatus(scan, 'done');
  }

  stopDhP2pTunnel(scan.dhProc);
}

/**
 * Starts a channel/stream discovery scan: brings up a single dh-p2p relay
 * tunnel for the device, then probes channels 1..maxChannels (both
 * subtypes) sequentially over that one tunnel, capturing a thumbnail for
 * each stream that responds.
 *
 * Returns once the tunnel is ready and scanning has begun — it does *not*
 * wait for the whole scan to finish, since that can take minutes. Callers
 * should poll `getScan(id)` for progress.
 */
async function startScan(params) {
  const scan = new Scan(params);
  scans.set(scan.id, scan);

  try {
    scan.rtspPort = await findFreePort();
    setStatus(scan, 'starting');

    const { proc, ready } = startDhP2pTunnel({
      serial: scan.serial,
      cloud: scan.cloud,
      rtspPort: scan.rtspPort,
      onLog: (source, line) => scan.appendLog(source, line),
    });
    scan.dhProc = proc;

    if (proc) {
      proc.on('exit', () => {
        if (scan.status === 'scanning' || scan.status === 'starting') {
          setStatus(scan, 'error', 'The P2P tunnel to the device closed unexpectedly during the scan.');
        }
      });
    }

    await ready;
    setStatus(scan, 'scanning');
  } catch (err) {
    setStatus(scan, 'error', err.message || String(err));
    stopDhP2pTunnel(scan.dhProc);
    return scan;
  }

  runScanLoop(scan).catch((err) => {
    if (scan.status !== 'error') {
      setStatus(scan, 'error', err.message || String(err));
    }
    stopDhP2pTunnel(scan.dhProc);
  });

  return scan;
}

function getScan(id) {
  return scans.get(id);
}

/** Stops an in-progress scan (keeps thumbnails already captured). */
function stopScan(id) {
  const scan = scans.get(id);
  if (!scan) return false;
  scan.cancelled = true;
  if (scan.currentProbeProc && !scan.currentProbeProc.killed) {
    try { scan.currentProbeProc.kill('SIGKILL'); } catch { /* already gone */ }
  }
  stopDhP2pTunnel(scan.dhProc);
  if (scan.status === 'scanning' || scan.status === 'starting') {
    setStatus(scan, 'stopped');
  }
  return true;
}

/** Stops (if running) and fully removes a scan, deleting its thumbnails. */
function deleteScan(id) {
  const scan = scans.get(id);
  if (!scan) return false;
  stopScan(id);
  fs.rm(scan.thumbDir, { recursive: true, force: true }, () => {});
  scans.delete(id);
  return true;
}

function stopAllScans() {
  for (const id of Array.from(scans.keys())) {
    stopScan(id);
  }
}

module.exports = {
  startScan,
  getScan,
  stopScan,
  deleteScan,
  stopAllScans,
  THUMB_ROOT,
};

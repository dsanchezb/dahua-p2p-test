'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { findFreePort } = require('./ports');
const { startDhP2pTunnel, stopDhP2pTunnel } = require('./dhTunnel');
const { buildRtspUrl } = require('./rtsp');
const { ensureDataDir } = require('./dataDir');

const RECORDINGS_ROOT = ensureDataDir('recordings');

// Below this much free space on the host filesystem, start trimming the
// oldest segment(s) of a recorder even if it's still under its own quota.
// Lightsail's smallest bundles ship a 20GB disk shared with the OS, ffmpeg,
// node_modules, etc. — this is a safety net against ever filling that disk,
// independent of whatever quota the user configures per recording.
const DISK_SAFETY_MARGIN_BYTES = 300 * 1024 * 1024; // 300 MB

// A gap between the end of one segment and the start of the next larger
// than this is treated as a recording discontinuity (tunnel drop/restart,
// or a manual stop+resume) rather than normal segment-boundary jitter.
const GAP_THRESHOLD_MS = 2_000;

// Backoff between automatic reconnect attempts while a recorder's status is
// 'recording'/'reconnecting' and the tunnel or ffmpeg died unexpectedly.
const RECONNECT_DELAY_MS = 5_000;

const DEFAULT_SEGMENT_SECONDS = 60;
const MIN_SEGMENT_SECONDS = 5;
const MAX_SEGMENT_SECONDS = 300;

const DEFAULT_QUOTA_GB = 1;
const MIN_QUOTA_GB = 0.1;
const MAX_QUOTA_GB = 15; // conservative cap given small Lightsail disks

fs.mkdirSync(RECORDINGS_ROOT, { recursive: true });

/** @type {Map<string, Recorder>} */
const recorders = new Map();

function freeDiskBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    // fs.statfs isn't available on every platform/Node build; fail open
    // (treat as "plenty of space") rather than block recording over it.
    return Infinity;
  }
}

function manifestPath(recorder) {
  return path.join(recorder.dir, 'manifest.json');
}

/**
 * Persists just enough to inspect/resume browsing a recorder's segments
 * after a server restart — explicitly NOT including username/password,
 * consistent with this app's existing promise that device credentials are
 * only ever held in server memory, never written to disk.
 */
function persistManifest(recorder) {
  // Guards against a race where ffmpeg's/dh-p2p's 'exit' handler fires
  // asynchronously after deleteRecording() has already started removing
  // recorder.dir (SIGTERM doesn't take effect instantly) — without this,
  // registerSegment()/enforceQuota() can recreate manifest.json (or a
  // trailing segment file) a moment after fs.rm swept the directory,
  // leaving a stray file/dir behind that fs.rm's single pass won't catch.
  if (recorder.deleted) return;

  const data = {
    id: recorder.id,
    serial: recorder.serial,
    channel: recorder.channel,
    subtype: recorder.subtype,
    cloud: recorder.cloud,
    quotaBytes: recorder.quotaBytes,
    segmentSeconds: recorder.segmentSeconds,
    createdAt: recorder.createdAt,
    segments: recorder.segments,
  };
  fs.writeFile(manifestPath(recorder), JSON.stringify(data), () => {});
}

class Recorder {
  constructor({ serial, username, password, channel, subtype, cloud, quotaBytes, segmentSeconds }) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.serial = serial;
    this.username = username;
    this.password = password;
    this.channel = channel;
    this.subtype = subtype;
    this.cloud = cloud;
    this.quotaBytes = quotaBytes;
    this.segmentSeconds = segmentSeconds;

    this.status = 'starting'; // starting -> recording <-> reconnecting -> stopped/error
    this.error = null;
    this.cancelled = false;
    this.deleted = false; // set by deleteRecording(); suppresses any further disk writes

    this.rtspPort = null;
    this.dhProc = null;
    this.ffmpegProc = null;

    // Chronological, oldest-first. Each entry: {file, startMs, durationSec, sizeBytes}.
    // `file` is an absolute path on disk; never exposed directly to clients
    // (toJSON() maps it to a relative URL instead).
    this.segments = [];
    this.usedBytes = 0;

    this.dir = path.join(RECORDINGS_ROOT, this.id);
    this.segmentsDir = path.join(this.dir, 'segments');

    this.log = [];
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
  }

  appendLog(source, line) {
    this.log.push(`[${source}] ${line}`);
    if (this.log.length > 500) this.log.shift();
    this.lastActivityAt = Date.now();
  }

  segmentUrl(absPath) {
    return `/recordings/${this.id}/segments/${path.basename(absPath)}`;
  }

  /** Gaps (discontinuities) between consecutive segments, in wall-clock ms. */
  computeGaps() {
    const gaps = [];
    for (let i = 1; i < this.segments.length; i++) {
      const prev = this.segments[i - 1];
      const cur = this.segments[i];
      const prevEnd = prev.startMs + prev.durationSec * 1000;
      if (cur.startMs - prevEnd > GAP_THRESHOLD_MS) {
        gaps.push({ fromMs: prevEnd, toMs: cur.startMs });
      }
    }
    return gaps;
  }

  toJSON() {
    const retainedSeconds = this.segments.reduce((sum, s) => sum + s.durationSec, 0);
    const oldestMs = this.segments.length ? this.segments[0].startMs : null;
    const newestEndMs = this.segments.length
      ? this.segments[this.segments.length - 1].startMs
        + this.segments[this.segments.length - 1].durationSec * 1000
      : null;

    return {
      id: this.id,
      status: this.status,
      error: this.error,
      serial: this.serial,
      channel: this.channel,
      subtype: this.subtype,
      cloud: this.cloud,
      quotaBytes: this.quotaBytes,
      usedBytes: this.usedBytes,
      remainingBytes: Math.max(0, this.quotaBytes - this.usedBytes),
      hostFreeBytes: freeDiskBytes(RECORDINGS_ROOT),
      segmentSeconds: this.segmentSeconds,
      segmentCount: this.segments.length,
      retainedSeconds,
      oldestMs,
      newestEndMs,
      gaps: this.computeGaps(),
      createdAt: this.createdAt,
      playlistUrl: this.segments.length ? `/api/recordings/${this.id}/playlist.m3u8` : null,
    };
  }

  /** Full segment list with client-facing relative URLs (no server paths). */
  segmentsJSON() {
    return this.segments.map((s) => ({
      startMs: s.startMs,
      durationSec: s.durationSec,
      sizeBytes: s.sizeBytes,
      url: this.segmentUrl(s.file),
    }));
  }
}

function setStatus(recorder, status, error) {
  recorder.status = status;
  if (error) recorder.error = String(error);
}

/** Deletes oldest segments until under quota and under the disk safety margin. */
function enforceQuota(recorder) {
  let total = recorder.segments.reduce((sum, s) => sum + s.sizeBytes, 0);

  while (
    recorder.segments.length > 1
    && (total > recorder.quotaBytes || freeDiskBytes(RECORDINGS_ROOT) < DISK_SAFETY_MARGIN_BYTES)
  ) {
    const oldest = recorder.segments.shift();
    fs.unlink(oldest.file, () => {});
    total -= oldest.sizeBytes;
    recorder.appendLog('recorder', `deleted oldest segment to free space: ${path.basename(oldest.file)}`);
  }

  if (recorder.segments.length === 1 && total > recorder.quotaBytes) {
    recorder.appendLog('recorder', 'warning: a single segment already exceeds the configured quota; keeping it (quota may be set too low for this stream\'s bitrate/segment length)');
  }

  recorder.usedBytes = total;
  persistManifest(recorder);
}

function registerSegment(recorder, file, startMs, durationSec) {
  if (recorder.deleted) {
    fs.unlink(file, () => {}); // best-effort; dir is likely already gone
    return;
  }

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(file).size;
  } catch {
    return; // file vanished (e.g. we're racing a stop/delete) — skip it
  }

  if (sizeBytes < 1000) {
    // Essentially empty — e.g. a reconnect happened within milliseconds of
    // ffmpeg opening a new segment file. Not worth keeping or counting.
    fs.unlink(file, () => {});
    return;
  }

  recorder.segments.push({ file, startMs, durationSec: Math.max(1, durationSec), sizeBytes });
  recorder.appendLog('recorder', `segment finalized: ${path.basename(file)} (${durationSec.toFixed(1)}s, ${(sizeBytes / 1024).toFixed(0)} KiB)`);
  enforceQuota(recorder);
}

/**
 * Runs one dh-p2p + ffmpeg attempt. Resolves once that attempt's ffmpeg
 * process exits for any reason (tunnel drop, kill on stop, etc.) having
 * already registered whatever segments it managed to finalize. Never
 * rejects — failures are logged and surfaced via recorder.status instead,
 * so the caller's reconnect loop doesn't need its own try/catch per field.
 */
function runOneAttempt(recorder) {
  return new Promise((resolve) => {
    const { proc: dhProc, ready } = startDhP2pTunnel({
      serial: recorder.serial,
      cloud: recorder.cloud,
      rtspPort: recorder.rtspPort,
      onLog: (source, line) => recorder.appendLog(source, line),
    });
    recorder.dhProc = dhProc;

    ready
      .then(() => {
        if (recorder.cancelled) {
          stopDhP2pTunnel(dhProc);
          resolve();
          return;
        }

        setStatus(recorder, 'recording');

        fs.mkdirSync(recorder.segmentsDir, { recursive: true });

        const rtspUrl = buildRtspUrl({
          username: recorder.username,
          password: recorder.password,
          rtspPort: recorder.rtspPort,
          channel: recorder.channel,
          subtype: recorder.subtype,
        });

        const segmentPattern = path.join(recorder.segmentsDir, 'seg_%Y%m%dT%H%M%S.ts');

        const args = [
          '-rtsp_transport', 'tcp',
          '-timeout', '15000000',
          '-i', rtspUrl,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-ac', '1',
          '-f', 'segment',
          '-segment_time', String(recorder.segmentSeconds),
          '-segment_format', 'mpegts',
          '-reset_timestamps', '1',
          '-strftime', '1',
          segmentPattern,
        ];

        const ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        recorder.ffmpegProc = ffmpegProc;

        let openSegment = null; // { file, startMs }

        const openRe = /Opening '([^']+\.ts)' for writing/;

        ffmpegProc.stderr.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          for (const line of text.split(/\r?\n/)) {
            if (!line) continue;
            recorder.appendLog('ffmpeg', line);

            const m = openRe.exec(line);
            if (m) {
              const newFile = m[1];
              const newStartMs = parseSegmentStartMs(newFile) ?? Date.now();

              if (openSegment) {
                const durationSec = (newStartMs - openSegment.startMs) / 1000;
                registerSegment(recorder, openSegment.file, openSegment.startMs, durationSec);
              }

              openSegment = { file: newFile, startMs: newStartMs };
            }

            if (/401 Unauthorized|Unauthorized|Server returned 401/.test(line)) {
              setStatus(recorder, 'error', 'The camera rejected the RTSP username/password (401 Unauthorized).');
            }
          }
        });

        const finishAttempt = () => {
          if (openSegment) {
            const durationSec = Math.min(
              recorder.segmentSeconds,
              (Date.now() - openSegment.startMs) / 1000,
            );
            registerSegment(recorder, openSegment.file, openSegment.startMs, durationSec);
            openSegment = null;
          }
          recorder.ffmpegProc = null;
          resolve();
        };

        ffmpegProc.on('error', (err) => {
          recorder.appendLog('ffmpeg', `spawn error: ${err.message}`);
          stopDhP2pTunnel(dhProc);
          finishAttempt();
        });

        ffmpegProc.on('exit', (code, signal) => {
          recorder.appendLog('ffmpeg', `process exited (code=${code}, signal=${signal})`);
          stopDhP2pTunnel(dhProc);
          finishAttempt();
        });

        // If the tunnel itself dies (not just ffmpeg), tear ffmpeg down too
        // so we don't keep an ffmpeg process spinning against a dead proxy.
        dhProc.on('exit', () => {
          if (recorder.ffmpegProc && !recorder.ffmpegProc.killed) {
            recorder.ffmpegProc.kill('SIGTERM');
          }
        });
      })
      .catch((err) => {
        recorder.appendLog('recorder', `tunnel attempt failed: ${err.message}`);
        // startDhP2pTunnel's `ready` promise can reject for reasons other
        // than the process having already exited (auth rejected, timeout
        // waiting for readiness) — in those cases dhProc is still running
        // and it's this caller's job to stop it, exactly as
        // sessionManager.js/channelScan.js already do in their own error
        // paths. Missing this left orphaned dh-p2p processes running
        // indefinitely after a failed/cancelled recording attempt.
        stopDhP2pTunnel(dhProc);
        resolve();
      });
  });
}

/** Extracts the segment's wall-clock start time from its strftime'd filename. */
function parseSegmentStartMs(file) {
  const m = /seg_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.ts$/.exec(path.basename(file));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // ffmpeg's strftime uses localtime; Date.UTC vs local doesn't matter here
  // as long as we're consistent, since this is only ever compared against
  // other values produced the same way (durations, gaps) or against
  // Date.now() on the same host.
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

async function recordLoop(recorder) {
  while (!recorder.cancelled) {
    // eslint-disable-next-line no-await-in-loop
    await runOneAttempt(recorder);

    if (recorder.cancelled) break;
    if (recorder.status === 'error') break; // auth rejected etc. — don't hammer retries

    setStatus(recorder, 'reconnecting');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
  }

  if (recorder.status !== 'error') {
    setStatus(recorder, 'stopped');
  }
}

async function startRecording(params) {
  const recorder = new Recorder(params);
  recorders.set(recorder.id, recorder);
  fs.mkdirSync(recorder.segmentsDir, { recursive: true });
  persistManifest(recorder);

  try {
    recorder.rtspPort = await findFreePort();
  } catch (err) {
    setStatus(recorder, 'error', err.message || String(err));
    return recorder;
  }

  // Don't await the full loop — it runs until stopped. Resolve once the
  // first attempt has either started recording or failed outright, so the
  // caller gets an immediate, meaningful status back.
  const firstAttemptSettled = new Promise((resolve) => {
    const check = () => {
      if (recorder.status !== 'starting') {
        resolve();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });

  recordLoop(recorder).catch((err) => {
    setStatus(recorder, 'error', err.message || String(err));
  });

  await firstAttemptSettled;
  return recorder;
}

function getRecording(id) {
  return recorders.get(id);
}

function listRecordings() {
  return Array.from(recorders.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Stops recording but keeps files on disk/manifest for later playback. */
function stopRecording(id) {
  const recorder = recorders.get(id);
  if (!recorder) return false;
  recorder.cancelled = true;
  stopFfmpeg(recorder);
  stopDhP2pTunnel(recorder.dhProc);
  if (recorder.status !== 'error') setStatus(recorder, 'stopped');
  return true;
}

function stopFfmpeg(recorder, graceMs = 2000) {
  const proc = recorder.ffmpegProc;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, graceMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Resumes a previously stopped (but not deleted) recorder in-place, using
 * the same credentials still held in memory, same directory and manifest —
 * new segments simply continue appending, with the stopped interval showing
 * up as a gap in the timeline.
 */
function resumeRecording(id) {
  const recorder = recorders.get(id);
  if (!recorder) return null;
  if (recorder.status !== 'stopped') return recorder;

  recorder.cancelled = false;
  recorder.error = null;
  setStatus(recorder, 'starting');
  recordLoop(recorder).catch((err) => {
    setStatus(recorder, 'error', err.message || String(err));
  });
  return recorder;
}

/** Stops (if running) and permanently deletes a recorder and its files. */
function deleteRecording(id) {
  const recorder = recorders.get(id);
  if (!recorder) return false;

  recorder.deleted = true; // stop any further manifest/segment writes first
  stopRecording(id);
  recorders.delete(id);

  // ffmpeg/dh-p2p's SIGTERM handling and 'exit' events are asynchronous, so
  // a segment file can still be mid-write for a brief moment after
  // stopRecording() returns. Retry the removal shortly after in case the
  // first pass raced a write and left something behind (recorder.deleted
  // now prevents it from writing anything *new*, so a second pass is
  // guaranteed to finish the job).
  const remove = () => fs.rm(recorder.dir, { recursive: true, force: true }, () => {});
  remove();
  setTimeout(remove, 500);

  return true;
}

function stopAllRecordings() {
  for (const id of Array.from(recorders.keys())) {
    stopRecording(id);
  }
}

/**
 * Resumes a stopped recorder using freshly-supplied credentials — needed
 * after a server restart, since usernames/passwords are only ever held in
 * memory (see persistManifest) and so don't survive the process exiting.
 */
function resumeRecordingWithCredentials(id, { username, password }) {
  const recorder = recorders.get(id);
  if (!recorder) return null;
  recorder.username = username;
  recorder.password = password;
  return resumeRecording(id);
}

/**
 * Reloads recorders from on-disk manifests (written by persistManifest) so
 * recordings made before a server restart remain visible/playable. These
 * come back in 'stopped' status with no credentials in memory — resuming
 * them requires calling resumeRecordingWithCredentials with the device's
 * username/password again, exactly as if starting a brand new recording.
 * Called once at server startup.
 */
function loadExistingRecordings() {
  let entries;
  try {
    entries = fs.readdirSync(RECORDINGS_ROOT, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(RECORDINGS_ROOT, entry.name);
    const manifestFile = path.join(dir, 'manifest.json');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch {
      continue; // not a recording dir, or manifest missing/corrupt — skip
    }

    const recorder = new Recorder({
      serial: data.serial,
      username: '',
      password: '',
      channel: data.channel,
      subtype: data.subtype,
      cloud: data.cloud,
      quotaBytes: data.quotaBytes,
      segmentSeconds: data.segmentSeconds,
    });
    recorder.id = data.id;
    recorder.createdAt = data.createdAt;
    recorder.dir = dir;
    recorder.segmentsDir = path.join(dir, 'segments');

    // Only keep segments that actually still exist on disk, in case the
    // process was killed mid-write for the most recent one.
    recorder.segments = (data.segments || []).filter((s) => {
      try {
        return fs.statSync(s.file).isFile();
      } catch {
        return false;
      }
    });
    recorder.usedBytes = recorder.segments.reduce((sum, s) => sum + s.sizeBytes, 0);
    setStatus(recorder, 'stopped');

    recorders.set(recorder.id, recorder);
  }
}

/**
 * Builds an HLS VOD playlist string covering all currently-finalized
 * segments, with EXT-X-DISCONTINUITY markers at gaps. Regenerated fresh on
 * every request, so it always reflects whatever's currently on disk
 * (including having had old segments trimmed by quota enforcement).
 */
function buildPlaylist(recorder) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(recorder.segmentSeconds)}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];

  let prevEndMs = null;
  for (const seg of recorder.segments) {
    if (prevEndMs !== null && seg.startMs - prevEndMs > GAP_THRESHOLD_MS) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXTINF:${seg.durationSec.toFixed(3)},`);
    lines.push(recorder.segmentUrl(seg.file));
    prevEndMs = seg.startMs + seg.durationSec * 1000;
  }

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function clampQuotaGb(quotaGb) {
  const g = Number(quotaGb);
  if (!Number.isFinite(g)) return DEFAULT_QUOTA_GB;
  return Math.min(MAX_QUOTA_GB, Math.max(MIN_QUOTA_GB, g));
}

function clampSegmentSeconds(segmentSeconds) {
  const s = Number(segmentSeconds);
  if (!Number.isFinite(s)) return DEFAULT_SEGMENT_SECONDS;
  return Math.min(MAX_SEGMENT_SECONDS, Math.max(MIN_SEGMENT_SECONDS, Math.round(s)));
}

module.exports = {
  RECORDINGS_ROOT,
  startRecording,
  getRecording,
  listRecordings,
  stopRecording,
  resumeRecording,
  resumeRecordingWithCredentials,
  deleteRecording,
  stopAllRecordings,
  loadExistingRecordings,
  buildPlaylist,
  clampQuotaGb,
  clampSegmentSeconds,
  DEFAULT_QUOTA_GB,
  MIN_QUOTA_GB,
  MAX_QUOTA_GB,
  DEFAULT_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  MAX_SEGMENT_SECONDS,
};

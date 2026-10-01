'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { findFreePort } = require('./ports');
const { startDhP2pTunnel, stopDhP2pTunnel } = require('./dhTunnel');
const { buildRtspUrl } = require('./rtsp');
const { ensureDataDir } = require('./dataDir');

const HLS_ROOT = ensureDataDir('hls');

/** @type {Map<string, Session>} */
const sessions = new Map();

class Session {
  constructor({ serial, username, password, channel, subtype, cloud }) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.serial = serial;
    this.username = username;
    this.password = password;
    this.channel = channel;
    this.subtype = subtype;
    this.cloud = cloud;

    this.status = 'starting'; // starting -> tunnel_ready -> streaming -> error/stopped
    this.error = null;
    this.rtspPort = null;
    this.dhProc = null;
    this.ffmpegProc = null;
    this.hlsDir = path.join(HLS_ROOT, this.id);
    this.log = [];
    this.createdAt = Date.now();
  }

  appendLog(source, line) {
    this.log.push(`[${source}] ${line}`);
    if (this.log.length > 500) this.log.shift();
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      serial: this.serial,
      channel: this.channel,
      subtype: this.subtype,
      cloud: this.cloud,
      playlistUrl: this.status === 'streaming' ? `/hls/${this.id}/index.m3u8` : null,
      createdAt: this.createdAt,
    };
  }
}

function setStatus(session, status, error) {
  session.status = status;
  if (error) session.error = String(error);
}

/**
 * Starts a dh-p2p relay-mode tunnel for the session's serial, waiting for it
 * to report readiness (a local RTSP proxy listening on session.rtspPort).
 * Also wires a post-ready exit handler so a tunnel that dies mid-stream
 * flips the session into an error state instead of silently going stale.
 */
function startDhP2p(session) {
  const { proc, ready } = startDhP2pTunnel({
    serial: session.serial,
    cloud: session.cloud,
    rtspPort: session.rtspPort,
    onLog: (source, line) => session.appendLog(source, line),
  });

  session.dhProc = proc;

  if (proc) {
    proc.on('exit', () => {
      if (session.status === 'streaming' || session.status === 'tunnel_ready') {
        setStatus(session, 'error', 'The P2P tunnel to the device closed unexpectedly.');
        stopFfmpeg(session);
      }
    });
  }

  return ready;
}

/**
 * Spawns ffmpeg to read the local RTSP proxy exposed by dh-p2p and re-encode
 * it into a browser-playable HLS ladder (single low-latency variant).
 */
function startFfmpeg(session) {
  fs.mkdirSync(session.hlsDir, { recursive: true });
  const playlistPath = path.join(session.hlsDir, 'index.m3u8');
  const rtspUrl = buildRtspUrl({
    username: session.username,
    password: session.password,
    rtspPort: session.rtspPort,
    channel: session.channel,
    subtype: session.subtype,
  });

  const args = [
    '-rtsp_transport', 'tcp',
    '-timeout', '15000000',
    '-i', rtspUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ac', '1',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(session.hlsDir, 'seg_%05d.ts'),
    playlistPath,
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.ffmpegProc = proc;

  let sawStreamMapping = false;

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      session.appendLog('ffmpeg', line);
      if (!sawStreamMapping && /Stream mapping:/.test(line)) {
        sawStreamMapping = true;
      }
      if (/401 Unauthorized|Unauthorized|Server returned 401/.test(line)) {
        setStatus(session, 'error', 'The camera rejected the RTSP username/password (401 Unauthorized). Double-check the device credentials (note: this is the device/NVR login, and some sub-accounts lack live-view permission).');
      }
      if (/Connection to tcp:.*failed|Connection refused|No route to host/.test(line)) {
        setStatus(session, 'error', `ffmpeg could not reach the local RTSP proxy: ${line.trim()}`);
      }
    }
  });

  proc.on('error', (err) => {
    session.appendLog('ffmpeg', `spawn error: ${err.message}`);
    if (session.status !== 'error') setStatus(session, 'error', `Failed to start ffmpeg: ${err.message}. Is ffmpeg installed and on PATH?`);
  });

  proc.on('exit', (code, signal) => {
    session.appendLog('ffmpeg', `process exited (code=${code}, signal=${signal})`);
    if (session.status === 'streaming' || session.status === 'tunnel_ready') {
      setStatus(session, 'error', session.error || `ffmpeg exited unexpectedly (code=${code}, signal=${signal}).`);
    }
  });

  // Poll for the playlist file to appear, which signals ffmpeg has at least
  // one segment ready and the browser can start playback.
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const maxWaitMs = 20_000;
    const check = () => {
      if (session.status === 'error') {
        reject(new Error(session.error || 'ffmpeg failed'));
        return;
      }
      if (fs.existsSync(playlistPath)) {
        resolve();
        return;
      }
      if (Date.now() - start > maxWaitMs) {
        reject(new Error('Timed out waiting for ffmpeg to produce the first HLS segment. The RTSP stream may not be reachable or the credentials may be rejected — check the session logs.'));
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

function stopFfmpeg(session) {
  if (session.ffmpegProc && !session.ffmpegProc.killed) {
    session.ffmpegProc.kill('SIGTERM');
  }
}

function cleanupHlsDir(session) {
  fs.rm(session.hlsDir, { recursive: true, force: true }, () => {});
}

async function createSession(params) {
  const session = new Session(params);
  sessions.set(session.id, session);

  try {
    session.rtspPort = await findFreePort();
    setStatus(session, 'starting');

    await startDhP2p(session);
    setStatus(session, 'tunnel_ready');

    await startFfmpeg(session);
    setStatus(session, 'streaming');
  } catch (err) {
    setStatus(session, 'error', err.message || String(err));
    stopFfmpeg(session);
    stopDhP2pTunnel(session.dhProc);
  }

  return session;
}

function getSession(id) {
  return sessions.get(id);
}

function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  stopFfmpeg(session);
  stopDhP2pTunnel(session.dhProc);
  setStatus(session, 'stopped');
  cleanupHlsDir(session);
  sessions.delete(id);
  return true;
}

// Best-effort cleanup on process exit so we don't leave dh-p2p/ffmpeg
// children or temp HLS files behind.
function stopAllSessions() {
  for (const id of Array.from(sessions.keys())) {
    stopSession(id);
  }
}

module.exports = {
  createSession,
  getSession,
  stopSession,
  stopAllSessions,
  HLS_ROOT,
};

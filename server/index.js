'use strict';

const path = require('path');
const express = require('express');

const { createSession, getSession, stopSession, stopAllSessions, HLS_ROOT } = require('./sessionManager');
const { startScan, getScan, stopScan, deleteScan, stopAllScans, THUMB_ROOT } = require('./channelScan');
const {
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
} = require('./recorder');

const app = express();
const PORT = process.env.PORT || 3000;

// Picks up recordings made before a prior server restart (as 'stopped',
// since their credentials don't survive a restart) so they stay visible
// and playable without the user having to do anything.
loadExistingRecordings();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// HLS segments/playlists are written to a per-session directory under
// HLS_ROOT by ffmpeg; serve them statically so hls.js in the browser can
// fetch index.m3u8 and the .ts segments.
app.use('/hls', express.static(HLS_ROOT, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Channel-scan thumbnails (JPEGs captured by channelScan.js), one
// subdirectory per scan.
app.use('/thumbnails', express.static(THUMB_ROOT, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Recorded .ts segments (recorder.js), one subdirectory per recording. The
// playlist itself is generated on the fly (see /api/recordings/:id/playlist.m3u8
// below) since it changes as segments are added/trimmed; only the raw
// segment files are served statically here.
app.use('/recordings', express.static(RECORDINGS_ROOT, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.post('/api/sessions', async (req, res) => {
  const { serial, username, password, channel, subtype, cloud } = req.body || {};

  if (!serial || typeof serial !== 'string' || !serial.trim()) {
    return res.status(400).json({ error: 'serial is required' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const session = await createSession({
    serial: serial.trim(),
    username: String(username),
    password: String(password),
    channel: channel ? String(channel) : '1',
    subtype: subtype !== undefined && subtype !== '' ? String(subtype) : '0',
    cloud: cloud ? String(cloud) : 'easy4ip',
  });

  const body = session.toJSON();
  const httpStatus = session.status === 'error' ? 502 : 201;
  return res.status(httpStatus).json(body);
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  return res.json(session.toJSON());
});

app.get('/api/sessions/:id/log', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  return res.json({ log: session.log });
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = stopSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'session not found' });
  return res.status(204).end();
});

// --- Channel/stream discovery -------------------------------------------
//
// Scans channels 1..maxChannels (default 16, Dahua's common NVR ceiling) on
// a single P2P tunnel, probing both subtypes per channel and capturing a
// thumbnail for whichever responds. Scanning is async and can take a while
// (each probe has its own RTSP-level timeout), so this starts the scan and
// the frontend polls GET /api/scans/:id for incremental per-channel results.

app.post('/api/scans', async (req, res) => {
  const { serial, username, password, cloud, maxChannels } = req.body || {};

  if (!serial || typeof serial !== 'string' || !serial.trim()) {
    return res.status(400).json({ error: 'serial is required' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  let maxCh = 16;
  if (maxChannels !== undefined && maxChannels !== '') {
    const parsed = Number(maxChannels);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
      return res.status(400).json({ error: 'maxChannels must be an integer between 1 and 64' });
    }
    maxCh = parsed;
  }

  const scan = await startScan({
    serial: serial.trim(),
    username: String(username),
    password: String(password),
    cloud: cloud ? String(cloud) : 'easy4ip',
    maxChannels: maxCh,
  });

  const body = scan.toJSON();
  const httpStatus = scan.status === 'error' ? 502 : 201;
  return res.status(httpStatus).json(body);
});

app.get('/api/scans/:id', (req, res) => {
  const scan = getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'scan not found' });
  return res.json(scan.toJSON());
});

app.get('/api/scans/:id/log', (req, res) => {
  const scan = getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'scan not found' });
  return res.json({ log: scan.log });
});

app.post('/api/scans/:id/stop', (req, res) => {
  const ok = stopScan(req.params.id);
  if (!ok) return res.status(404).json({ error: 'scan not found' });
  return res.json(getScan(req.params.id).toJSON());
});

app.delete('/api/scans/:id', (req, res) => {
  const ok = deleteScan(req.params.id);
  if (!ok) return res.status(404).json({ error: 'scan not found' });
  return res.status(204).end();
});

// --- Continuous (loop) recording -----------------------------------------
//
// A recorder holds its own long-lived P2P tunnel + ffmpeg process, writing
// fixed-length .ts segments to disk and deleting the oldest ones once the
// recording exceeds its configured quota (or the host disk gets low on
// space). It keeps running on the server regardless of whether any browser
// tab is open; the frontend just polls status/segment list for display and
// requests a freshly-built VOD playlist to scrub through what's on disk.

app.post('/api/recordings', async (req, res) => {
  const { serial, username, password, channel, subtype, cloud, quotaGb, segmentSeconds } = req.body || {};

  if (!serial || typeof serial !== 'string' || !serial.trim()) {
    return res.status(400).json({ error: 'serial is required' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const recorder = await startRecording({
    serial: serial.trim(),
    username: String(username),
    password: String(password),
    channel: channel ? String(channel) : '1',
    subtype: subtype !== undefined && subtype !== '' ? String(subtype) : '0',
    cloud: cloud ? String(cloud) : 'easy4ip',
    quotaBytes: Math.round(clampQuotaGb(quotaGb) * 1024 * 1024 * 1024),
    segmentSeconds: clampSegmentSeconds(segmentSeconds),
  });

  const body = recorder.toJSON();
  const httpStatus = recorder.status === 'error' ? 502 : 201;
  return res.status(httpStatus).json(body);
});

app.get('/api/recordings', (_req, res) => {
  return res.json({ recordings: listRecordings().map((r) => r.toJSON()) });
});

app.get('/api/recordings/:id', (req, res) => {
  const recorder = getRecording(req.params.id);
  if (!recorder) return res.status(404).json({ error: 'recording not found' });
  return res.json(recorder.toJSON());
});

app.get('/api/recordings/:id/segments', (req, res) => {
  const recorder = getRecording(req.params.id);
  if (!recorder) return res.status(404).json({ error: 'recording not found' });
  return res.json({ segments: recorder.segmentsJSON() });
});

app.get('/api/recordings/:id/log', (req, res) => {
  const recorder = getRecording(req.params.id);
  if (!recorder) return res.status(404).json({ error: 'recording not found' });
  return res.json({ log: recorder.log });
});

app.get('/api/recordings/:id/playlist.m3u8', (req, res) => {
  const recorder = getRecording(req.params.id);
  if (!recorder) return res.status(404).json({ error: 'recording not found' });
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(buildPlaylist(recorder));
});

app.post('/api/recordings/:id/stop', (req, res) => {
  const ok = stopRecording(req.params.id);
  if (!ok) return res.status(404).json({ error: 'recording not found' });
  return res.json(getRecording(req.params.id).toJSON());
});

app.post('/api/recordings/:id/resume', (req, res) => {
  const existing = getRecording(req.params.id);
  if (!existing) return res.status(404).json({ error: 'recording not found' });

  const { username, password } = req.body || {};
  let recorder;
  if (username && password) {
    // Needed when resuming a recorder reloaded from disk after a server
    // restart: credentials are never persisted, so they have to be
    // re-supplied here, exactly as when starting a brand new recording.
    recorder = resumeRecordingWithCredentials(req.params.id, {
      username: String(username),
      password: String(password),
    });
  } else if (existing.username && existing.password) {
    recorder = resumeRecording(req.params.id);
  } else {
    return res.status(400).json({
      error: 'username and password are required to resume this recording (its credentials are not held in memory, likely because the server restarted since it was last running)',
    });
  }

  return res.json(recorder.toJSON());
});

app.delete('/api/recordings/:id', (req, res) => {
  const ok = deleteRecording(req.params.id);
  if (!ok) return res.status(404).json({ error: 'recording not found' });
  return res.status(204).end();
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Dahua P2P live viewer listening on http://localhost:${PORT}`);
});

function shutdown() {
  stopAllSessions();
  stopAllScans();
  stopAllRecordings();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

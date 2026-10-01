'use strict';

const path = require('path');
const express = require('express');

const { createSession, getSession, stopSession, stopAllSessions, HLS_ROOT } = require('./sessionManager');
const { startScan, getScan, stopScan, deleteScan, stopAllScans, THUMB_ROOT } = require('./channelScan');

const app = express();
const PORT = process.env.PORT || 3000;

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

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Dahua P2P live viewer listening on http://localhost:${PORT}`);
});

function shutdown() {
  stopAllSessions();
  stopAllScans();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

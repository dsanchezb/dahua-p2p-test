'use strict';

const path = require('path');
const express = require('express');

const { createSession, getSession, stopSession, HLS_ROOT } = require('./sessionManager');

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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Dahua P2P live viewer listening on http://localhost:${PORT}`);
});

(() => {
  const form = document.getElementById('connect-form');
  const connectBtn = document.getElementById('connect-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const video = document.getElementById('video');

  let sessionId = null;
  let hls = null;
  let pollTimer = null;
  let logTimer = null;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `status status-${kind}`;
  }

  function setFormEnabled(enabled) {
    connectBtn.disabled = !enabled;
    disconnectBtn.disabled = enabled;
    for (const el of form.elements) {
      if (el === disconnectBtn) continue;
      el.disabled = !enabled;
    }
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (logTimer) clearInterval(logTimer);
    pollTimer = null;
    logTimer = null;
  }

  function teardownPlayer() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function startPlayer(playlistUrl) {
    teardownPlayer();
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ liveDurationInfinity: true });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          setStatus(`Playback error: ${data.type} (${data.details})`, 'error');
        }
      });
      video.play().catch(() => {});
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlistUrl;
      video.play().catch(() => {});
    } else {
      setStatus('This browser cannot play HLS and hls.js failed to load.', 'error');
    }
  }

  async function fetchLog() {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/log`);
      if (!res.ok) return;
      const data = await res.json();
      logEl.textContent = data.log.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    } catch {
      /* ignore transient errors */
    }
  }

  async function pollStatus() {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) {
        setStatus('Session no longer exists.', 'error');
        stopPolling();
        setFormEnabled(true);
        return;
      }
      const data = await res.json();
      applyStatus(data);
    } catch {
      /* ignore transient errors */
    }
  }

  function applyStatus(data) {
    switch (data.status) {
      case 'starting':
        setStatus('Establishing P2P tunnel to the device…', 'progress');
        break;
      case 'tunnel_ready':
        setStatus('Tunnel established. Starting RTSP → HLS transcode…', 'progress');
        break;
      case 'streaming':
        setStatus('Streaming live.', 'ok');
        if (data.playlistUrl) startPlayer(data.playlistUrl);
        break;
      case 'error':
        setStatus(`Error: ${data.error || 'unknown error'}`, 'error');
        stopPolling();
        setFormEnabled(true);
        break;
      case 'stopped':
        setStatus('Disconnected.', 'idle');
        stopPolling();
        setFormEnabled(true);
        break;
      default:
        break;
    }
  }

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    setFormEnabled(false);
    teardownPlayer();
    logEl.textContent = '';
    setStatus('Connecting…', 'progress');

    const payload = {
      serial: document.getElementById('serial').value.trim(),
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
      channel: document.getElementById('channel').value || '1',
      subtype: document.getElementById('subtype').value || '0',
    };

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus(`Error: ${data.error || 'failed to start session'}`, 'error');
        setFormEnabled(true);
        return;
      }

      sessionId = data.id;
      disconnectBtn.disabled = false;
      applyStatus(data);

      pollTimer = setInterval(pollStatus, 1500);
      logTimer = setInterval(fetchLog, 1500);
      fetchLog();
    } catch (err) {
      setStatus(`Request failed: ${err.message}`, 'error');
      setFormEnabled(true);
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    if (!sessionId) return;
    disconnectBtn.disabled = true;
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    } catch {
      /* ignore */
    }
    stopPolling();
    teardownPlayer();
    setStatus('Disconnected.', 'idle');
    setFormEnabled(true);
    sessionId = null;
  });
})();

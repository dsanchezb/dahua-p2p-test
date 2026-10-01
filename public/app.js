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

  // --- Channel/stream discovery ------------------------------------------

  const scanStartBtn = document.getElementById('scan-start-btn');
  const scanStopBtn = document.getElementById('scan-stop-btn');
  const scanMaxChannelsInput = document.getElementById('scan-max-channels');
  const scanStatusEl = document.getElementById('scan-status');
  const scanProgressWrap = document.getElementById('scan-progress');
  const scanProgressBar = document.getElementById('scan-progress-bar');
  const channelGrid = document.getElementById('channel-grid');
  const channelsDetails = document.getElementById('channels-details');

  let scanId = null;
  let scanPollTimer = null;
  const renderedChannels = new Map(); // channel number -> grid cell element

  function setScanStatus(text, kind) {
    scanStatusEl.textContent = text;
    scanStatusEl.className = `status status-${kind}`;
  }

  function stopScanPolling() {
    if (scanPollTimer) clearInterval(scanPollTimer);
    scanPollTimer = null;
  }

  function currentCredentials() {
    return {
      serial: document.getElementById('serial').value.trim(),
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    };
  }

  function renderChannelCell(channelInfo) {
    let cell = renderedChannels.get(channelInfo.channel);

    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'channel-cell';
      cell.dataset.channel = String(channelInfo.channel);
      channelGrid.appendChild(cell);
      renderedChannels.set(channelInfo.channel, cell);
    }

    const label = `Channel ${channelInfo.channel}`;
    let bodyHtml;

    if (channelInfo.state === 'probing') {
      cell.className = 'channel-cell channel-cell-probing';
      bodyHtml = `
        <div class="channel-thumb channel-thumb-pending">Probing&hellip;</div>
        <div class="channel-label">${label}</div>
      `;
    } else if (channelInfo.available) {
      cell.className = 'channel-cell channel-cell-available';
      const subBadges = [0, 1]
        .map((st) => {
          const ok = channelInfo.subtypes[st];
          const cls = ok ? 'sub-badge sub-badge-ok' : 'sub-badge sub-badge-missing';
          return `<span class="${cls}">sub ${st}: ${ok ? 'yes' : 'no'}</span>`;
        })
        .join('');
      bodyHtml = `
        <button type="button" class="channel-thumb-btn" data-action="view" data-channel="${channelInfo.channel}" data-subtype="${channelInfo.thumbnailSubtype}">
          <img class="channel-thumb" src="${channelInfo.thumbnailUrl}" alt="${label} thumbnail" loading="lazy" />
        </button>
        <div class="channel-label">${label}</div>
        <div class="sub-badges">${subBadges}</div>
      `;
    } else {
      cell.className = 'channel-cell channel-cell-empty';
      bodyHtml = `
        <div class="channel-thumb channel-thumb-empty">No stream</div>
        <div class="channel-label">${label}</div>
      `;
    }

    cell.innerHTML = bodyHtml;
  }

  function renderScan(data) {
    for (const channelInfo of data.channels) {
      renderChannelCell(channelInfo);
    }

    const totalKnown = Math.max(data.progress, data.channels.length);
    if (data.maxChannels > 0) {
      scanProgressWrap.hidden = false;
      const pct = Math.min(100, Math.round((totalKnown / data.maxChannels) * 100));
      scanProgressBar.style.width = `${pct}%`;
    }

    switch (data.status) {
      case 'starting':
        setScanStatus('Establishing P2P tunnel for channel discovery…', 'progress');
        break;
      case 'scanning':
        setScanStatus(`Scanning… checked ${data.progress} of ${data.maxChannels} channel(s).`, 'progress');
        break;
      case 'done': {
        const foundCount = data.channels.filter((c) => c.available).length;
        const note = data.earlyStopped ? ' (stopped early after several empty channels)' : '';
        setScanStatus(`Scan complete: ${foundCount} channel(s) with a live stream found${note}.`, 'ok');
        stopScanPolling();
        scanStartBtn.disabled = false;
        scanStopBtn.disabled = true;
        break;
      }
      case 'stopped':
        setScanStatus('Scan stopped.', 'idle');
        stopScanPolling();
        scanStartBtn.disabled = false;
        scanStopBtn.disabled = true;
        break;
      case 'error':
        setScanStatus(`Scan error: ${data.error || 'unknown error'}`, 'error');
        stopScanPolling();
        scanStartBtn.disabled = false;
        scanStopBtn.disabled = true;
        break;
      default:
        break;
    }
  }

  async function pollScan() {
    if (!scanId) return;
    try {
      const res = await fetch(`/api/scans/${scanId}`);
      if (!res.ok) {
        setScanStatus('Scan no longer exists.', 'error');
        stopScanPolling();
        scanStartBtn.disabled = false;
        scanStopBtn.disabled = true;
        return;
      }
      const data = await res.json();
      renderScan(data);
    } catch {
      /* ignore transient errors */
    }
  }

  scanStartBtn.addEventListener('click', async () => {
    const { serial, username, password } = currentCredentials();

    if (!serial || !username || !password) {
      setScanStatus('Fill in Device Serial, Username and Password above first.', 'error');
      return;
    }

    const maxChannels = Number(scanMaxChannelsInput.value) || 16;

    scanStartBtn.disabled = true;
    scanStopBtn.disabled = false;
    channelGrid.innerHTML = '';
    renderedChannels.clear();
    scanProgressWrap.hidden = true;
    scanProgressBar.style.width = '0%';
    setScanStatus('Starting channel discovery…', 'progress');

    try {
      const res = await fetch('/api/scans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial, username, password, maxChannels }),
      });
      const data = await res.json();

      if (!res.ok) {
        setScanStatus(`Error: ${data.error || 'failed to start scan'}`, 'error');
        scanStartBtn.disabled = false;
        scanStopBtn.disabled = true;
        return;
      }

      scanId = data.id;
      renderScan(data);

      if (data.status === 'starting' || data.status === 'scanning') {
        scanPollTimer = setInterval(pollScan, 1500);
      } else {
        scanStartBtn.disabled = false;
        scanStopBtn.disabled = true;
      }
    } catch (err) {
      setScanStatus(`Request failed: ${err.message}`, 'error');
      scanStartBtn.disabled = false;
      scanStopBtn.disabled = true;
    }
  });

  scanStopBtn.addEventListener('click', async () => {
    if (!scanId) return;
    scanStopBtn.disabled = true;
    try {
      const res = await fetch(`/api/scans/${scanId}/stop`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        renderScan(data);
      }
    } catch {
      /* ignore */
    }
    stopScanPolling();
    scanStartBtn.disabled = false;
  });

  // Clicking a discovered thumbnail copies its channel/subtype into the
  // live-view form above and starts a normal live session with it, so the
  // gallery doubles as a quick-connect picker.
  channelGrid.addEventListener('click', (evt) => {
    const btn = evt.target.closest('[data-action="view"]');
    if (!btn) return;

    const channel = btn.dataset.channel;
    const subtype = btn.dataset.subtype;

    document.getElementById('channel').value = channel;
    document.getElementById('subtype').value = subtype === '1' ? '1' : '0';

    channelsDetails.open = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.requestSubmit();
  });
})();

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

  // --- Continuous (loop) recording ---------------------------------------

  const recordForm = document.getElementById('record-form');
  const recordStartBtn = document.getElementById('record-start-btn');
  const recordingsListEl = document.getElementById('recordings-list');

  const playbackPanel = document.getElementById('playback-panel');
  const playbackTitle = document.getElementById('playback-title');
  const playbackVideo = document.getElementById('playback-video');
  const timelineEl = document.getElementById('timeline');
  const timelinePlayedEl = document.getElementById('timeline-played');
  const timelineGapsEl = document.getElementById('timeline-gaps');
  const timelineCursorEl = document.getElementById('timeline-cursor');
  const timelineStartLabel = document.getElementById('timeline-start-label');
  const timelineEndLabel = document.getElementById('timeline-end-label');

  // Known recording ids this tab has seen, so periodic refreshes can tell
  // "new recording appeared" apart from "existing one updated" without
  // re-fetching the full list structure every poll.
  let recordingsPollTimer = null;
  let playbackHls = null;
  let playbackRecorder = null; // the recording object currently loaded in the player

  // The HLS VOD playlist concatenates segments back-to-back with no actual
  // gap in player time (an EXT-X-DISCONTINUITY doesn't add duration) — only
  // the *wall-clock* timestamps have gaps where the tunnel dropped. So the
  // timeline is built from the segment list's actual durations, not from
  // oldestMs..newestEndMs, and gaps are shown as thin markers at the right
  // *content-time* offset rather than stretched proportionally to how long
  // the gap lasted in the real world.
  let playbackTotalDuration = 0; // sum of segment durations, in seconds
  let playbackGapOffsets = []; // [{ offsetSec, fromMs, toMs }]

  function formatBytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(totalSeconds) {
    if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '—';
    const s = Math.floor(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function formatClock(ms) {
    if (ms == null) return '—';
    const d = new Date(ms);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function recordingStatusLabel(rec) {
    switch (rec.status) {
      case 'starting': return 'Starting…';
      case 'recording': return 'Recording';
      case 'reconnecting': return 'Reconnecting…';
      case 'stopped': return 'Stopped';
      case 'error': return 'Error';
      default: return rec.status;
    }
  }

  function renderRecordingCard(rec) {
    let card = recordingsListEl.querySelector(`[data-recording-id="${rec.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'recording-card';
      card.dataset.recordingId = rec.id;
      recordingsListEl.prepend(card);
    }

    card.className = `recording-card is-${rec.status}`;

    const usedPct = rec.quotaBytes > 0 ? Math.min(100, (rec.usedBytes / rec.quotaBytes) * 100) : 0;
    const nearFull = usedPct >= 90;

    const canResume = rec.status === 'stopped';
    const canStop = rec.status === 'recording' || rec.status === 'reconnecting' || rec.status === 'starting';
    const canWatch = Boolean(rec.playlistUrl);

    card.innerHTML = `
      <div class="recording-card-head">
        <div class="recording-card-title">
          <span class="rec-dot"></span>
          Ch ${rec.channel} / sub ${rec.subtype} &mdash; ${recordingStatusLabel(rec)}
        </div>
        <div class="recording-card-actions">
          ${canWatch ? `<button type="button" data-action="watch">Watch</button>` : ''}
          ${canStop ? `<button type="button" data-action="stop">Stop</button>` : ''}
          ${canResume ? `<button type="button" data-action="resume">Resume</button>` : ''}
          <button type="button" class="btn-danger" data-action="delete">Delete</button>
        </div>
      </div>
      <div class="recording-stats">
        <span>Retained: <strong>${formatDuration(rec.retainedSeconds)}</strong></span>
        <span>Space used: <strong>${formatBytes(rec.usedBytes)}</strong> / ${formatBytes(rec.quotaBytes)}</span>
        <span>Remaining: <strong>${formatBytes(rec.remainingBytes)}</strong></span>
        <span>Segments: <strong>${rec.segmentCount}</strong></span>
        <span>Since: <strong>${formatClock(rec.oldestMs)}</strong></span>
      </div>
      <div class="recording-space-bar">
        <div class="recording-space-bar-fill${nearFull ? ' is-near-full' : ''}" style="width:${usedPct.toFixed(1)}%"></div>
      </div>
      ${rec.error ? `<div class="recording-error">${rec.error}</div>` : ''}
    `;

    card.dataset.serial = rec.serial;
  }

  async function refreshRecordings() {
    try {
      const res = await fetch('/api/recordings');
      if (!res.ok) return;
      const data = await res.json();

      const seenIds = new Set();
      for (const rec of data.recordings) {
        seenIds.add(rec.id);
        renderRecordingCard(rec);
      }

      // Drop cards for recordings that were deleted elsewhere (e.g. another
      // tab, or server restart losing an entry that was never persisted).
      for (const card of Array.from(recordingsListEl.children)) {
        if (!seenIds.has(card.dataset.recordingId)) card.remove();
      }

      if (playbackRecorder && seenIds.has(playbackRecorder.id)) {
        const updated = data.recordings.find((r) => r.id === playbackRecorder.id);
        if (updated) playbackRecorder = updated;
        // Note: deliberately not refreshing the loaded playlist/timeline
        // markers here while the player is open — doing so mid-scrub would
        // yank the playhead out from under the user. Re-opening via Watch
        // picks up new segments/gaps.
      }
    } catch {
      /* ignore transient errors */
    }
  }

  function startRecordingsPolling() {
    if (recordingsPollTimer) return;
    recordingsPollTimer = setInterval(refreshRecordings, 4000);
  }

  recordForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();

    const { serial, username, password } = currentCredentials();
    if (!serial || !username || !password) {
      alert('Fill in Device Serial, Username and Password in the Connect panel above first.');
      return;
    }

    const payload = {
      serial,
      username,
      password,
      channel: document.getElementById('record-channel').value || '1',
      subtype: document.getElementById('record-subtype').value || '0',
      quotaGb: document.getElementById('record-quota').value || '1',
      segmentSeconds: document.getElementById('record-segment-seconds').value || '60',
    };

    recordStartBtn.disabled = true;
    try {
      const res = await fetch('/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Could not start recording: ${data.error || 'unknown error'}`);
      } else {
        renderRecordingCard(data);
        startRecordingsPolling();
      }
    } catch (err) {
      alert(`Request failed: ${err.message}`);
    } finally {
      recordStartBtn.disabled = false;
    }
  });

  recordingsListEl.addEventListener('click', async (evt) => {
    const btn = evt.target.closest('button[data-action]');
    if (!btn) return;
    const card = btn.closest('.recording-card');
    const id = card?.dataset.recordingId;
    if (!id) return;

    const action = btn.dataset.action;

    if (action === 'watch') {
      openPlayback(id);
      return;
    }

    if (action === 'stop') {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/recordings/${id}/stop`, { method: 'POST' });
        if (res.ok) renderRecordingCard(await res.json());
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (action === 'resume') {
      const { username, password } = currentCredentials();
      if (!username || !password) {
        alert('Enter the Username and Password in the Connect panel above, then click Resume again.');
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch(`/api/recordings/${id}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(`Could not resume: ${data.error || 'unknown error'}`);
        } else {
          renderRecordingCard(data);
          startRecordingsPolling();
        }
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (action === 'delete') {
      if (!confirm('Delete this recording and all its footage? This cannot be undone.')) return;
      btn.disabled = true;
      try {
        await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
        card.remove();
        if (playbackRecorder && playbackRecorder.id === id) {
          closePlayback();
        }
      } finally {
        btn.disabled = false;
      }
    }
  });

  /**
   * Recomputes playbackTotalDuration / playbackGapOffsets from the
   * recording's actual segment list (actual durations, not wall-clock
   * span), so timeline positions correspond 1:1 with the HLS player's own
   * (gapless) timeline.
   */
  async function loadTimelineFromSegments(id) {
    const res = await fetch(`/api/recordings/${id}/segments`);
    if (!res.ok) return { totalDuration: 0, gaps: [] };
    const data = await res.json();

    let offset = 0;
    let prevEndMs = null;
    const gaps = [];

    for (const seg of data.segments) {
      if (prevEndMs !== null && seg.startMs - prevEndMs > 2000) {
        gaps.push({ offsetSec: offset, fromMs: prevEndMs, toMs: seg.startMs });
      }
      offset += seg.durationSec;
      prevEndMs = seg.startMs + seg.durationSec * 1000;
    }

    return { totalDuration: offset, gaps };
  }

  function renderTimelineGaps() {
    timelineGapsEl.innerHTML = '';
    if (playbackTotalDuration <= 0) return;

    for (const gap of playbackGapOffsets) {
      const left = (gap.offsetSec / playbackTotalDuration) * 100;
      const marker = document.createElement('div');
      marker.className = 'timeline-gap-marker';
      marker.style.left = `${left}%`;
      marker.style.width = '2px';
      marker.title = `Recording gap: ${formatClock(gap.fromMs)} \u2192 ${formatClock(gap.toMs)}`;
      timelineGapsEl.appendChild(marker);
    }
  }

  function updateTimelineCursor() {
    const duration = playbackTotalDuration || playbackVideo.duration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) return;

    const pct = Math.min(100, Math.max(0, (playbackVideo.currentTime / duration) * 100));
    timelineCursorEl.hidden = false;
    timelineCursorEl.style.left = `${pct}%`;
    timelinePlayedEl.style.width = `${pct}%`;
  }

  async function openPlayback(id) {
    try {
      const res = await fetch(`/api/recordings/${id}`);
      if (!res.ok) {
        alert('Could not load this recording.');
        return;
      }
      const rec = await res.json();
      if (!rec.playlistUrl) {
        alert('This recording has no footage yet.');
        return;
      }

      const { totalDuration, gaps } = await loadTimelineFromSegments(id);
      playbackTotalDuration = totalDuration;
      playbackGapOffsets = gaps;

      playbackRecorder = rec;
      playbackPanel.hidden = false;
      playbackTitle.textContent = `Playback — Channel ${rec.channel} / sub ${rec.subtype} (${formatDuration(rec.retainedSeconds)} retained)`;
      timelineStartLabel.textContent = formatClock(rec.oldestMs);
      timelineEndLabel.textContent = formatClock(rec.newestEndMs);
      renderTimelineGaps();
      timelinePlayedEl.style.width = '0%';
      timelineCursorEl.hidden = true;

      if (playbackHls) {
        playbackHls.destroy();
        playbackHls = null;
      }

      const playlistUrl = `${rec.playlistUrl}?t=${Date.now()}`; // bust any caching mid-recording

      if (window.Hls && window.Hls.isSupported()) {
        playbackHls = new window.Hls();
        playbackHls.loadSource(playlistUrl);
        playbackHls.attachMedia(playbackVideo);
      } else if (playbackVideo.canPlayType('application/vnd.apple.mpegurl')) {
        playbackVideo.src = playlistUrl;
      } else {
        alert('This browser cannot play HLS and hls.js failed to load.');
        return;
      }

      playbackPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      alert(`Failed to open playback: ${err.message}`);
    }
  }

  function closePlayback() {
    if (playbackHls) {
      playbackHls.destroy();
      playbackHls = null;
    }
    playbackVideo.pause();
    playbackVideo.removeAttribute('src');
    playbackVideo.load();
    playbackPanel.hidden = true;
    playbackRecorder = null;
    playbackTotalDuration = 0;
    playbackGapOffsets = [];
  }

  playbackVideo.addEventListener('timeupdate', updateTimelineCursor);

  timelineEl.addEventListener('click', (evt) => {
    const duration = playbackVideo.duration;
    if (!playbackRecorder || !duration || !Number.isFinite(duration)) return;
    const rect = timelineEl.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));

    // The timeline's 0-100% maps directly onto the player's own (gapless)
    // duration — see loadTimelineFromSegments — so clicking anywhere always
    // lands on real, playable content.
    playbackVideo.currentTime = pct * duration;
    playbackVideo.play().catch(() => {});
  });

  // Pick up any recordings already running on the server (e.g. started in
  // an earlier browser session, or before a page refresh) as soon as the
  // page loads, since recording is designed to keep going in the
  // background independent of the browser.
  refreshRecordings().then(() => {
    if (recordingsListEl.children.length > 0) startRecordingsPolling();
  });
})();

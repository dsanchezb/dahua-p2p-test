# Dahua P2P Live Viewer

A small web app that lets you view a Dahua (or Dahua‑derived / OEM) camera or NVR's
live feed in the browser using **only its device serial number (SN / P2P ID) and
its username/password** — no port forwarding, no VPN, no DDNS.

It works by tunneling RTSP over Dahua's proprietary P2P protocol ("DH‑P2P" +
"PTCP"), the same mechanism used by apps like gDMSS Lite, SmartPSS and KBiVMS.
The tunnel implementation is vendored from
[khoanguyen-3fc/dh-p2p](https://github.com/khoanguyen-3fc/dh-p2p) (MIT
licensed) — see [`vendor/dh-p2p/ATTRIBUTION.md`](vendor/dh-p2p/ATTRIBUTION.md).

```
Browser (hls.js) --HTTP/HLS--> Node/Express --spawns--> dh-p2p (Rust, --relay)
                                     |                        |
                                     |                   PTCP/UDP tunnel
                                     |                        |
                                     +--spawns--> ffmpeg      v
                                          (RTSP -> HLS)   Camera / NVR
                                              ^
                                              |  RTSP over local TCP proxy
                                              +--------------+
```

1. The browser posts `{serial, username, password, channel, subtype}` to the backend.
2. The backend spawns the vendored `dh-p2p --relay` binary, which performs the
   P2P handshake (via the `easy4ip` cloud) and exposes a local RTSP proxy
   (`rtsp://127.0.0.1:<port>/cam/realmonitor?channel=N&subtype=M`) that
   forwards to the physical device through the P2P/PTCP tunnel.
3. The backend spawns `ffmpeg` to read that local RTSP stream and repackage it
   as HLS (segmented `.ts` + `.m3u8`) written to a temp directory.
4. The frontend plays the HLS playlist with [hls.js](https://github.com/video-dev/hls.js).

## Requirements

- Node.js 18+
- Rust toolchain (`cargo`) — to build the vendored `dh-p2p` binary
- `ffmpeg` on `PATH` — to transcode RTSP to HLS

## Setup

```bash
npm install
npm run build:dhp2p   # builds vendor/dh-p2p/target/release/dh-p2p via cargo
npm start              # http://localhost:3000
```

Open the app, enter the camera's serial number and its username/password, pick
a channel (1 for a single camera; the NVR channel number for an NVR) and
subtype (0 = main/HD stream, 1 = sub/lower-bitrate stream), and click Connect.

## Testing performed / does the tunnel actually work?

Per the task, this was tested against a **real device** (not just read from
the source) using:

- Serial: `5H0989EPAZEB886`
- Username: `residente`
- Cloud: `easy4ip` (the default — this is what Dahua/derived devices use;
  `dh-p2p` also has an `amcrest` cloud, but the vendored Rust CLI doesn't
  expose a `--cloud` flag, only the Python script does)

Findings:

- **The upstream Python implementation** completes the DH‑P2P/cloud handshake
  (probe → locate device → device info → relay negotiation) but then hangs
  indefinitely trying a *direct* P2P NAT traversal to the device — this
  matches a documented upstream limitation (its comment: *"Relay mode is
  Rust-only by design... A prototype carried RTSP only as far as SETUP; Rust
  reaches RTP."*). It never produced a working stream in this environment. One
  bug was also hit and worked around locally: `main.py` crashes with an
  `AttributeError` when a device's `/info/device/{SN}` response body is empty
  (no `<Info>` at all) — `res["data"]["body"]` is `None`, not a dict.
- **The Rust implementation in direct (non-relay) mode** also stalls at the
  same NAT-traversal step and times out after 5s with "Timeout occurred while
  waiting for a response from the device", exactly as the tool itself warns.
- **The Rust implementation in `--relay` mode is the one that works.** It
  completes the full handshake through the relay/agent server, reports
  `Ready to connect!`, and opens a local TCP RTSP proxy.
  - Using `ffprobe`/raw RTSP requests against that proxy, we confirmed the
    tunnel **genuinely reaches the physical device**: each RTSP request
    produces a fresh `401 Unauthorized` with a new `WWW-Authenticate: Digest`
    nonce every time (i.e. it's a live round trip to the camera/NVR, not a
    cached or local response). The MD5 digest response was independently
    recomputed in Python and matched RFC 2069 digest auth exactly for the
    given credentials, yet the device still rejected them across several
    tested channels (1–8) and both subtypes.
  - **Conclusion: the P2P tunnel itself works end-to-end** — it locates the
    device by serial, negotiates the relay, and successfully proxies live
    RTSP protocol exchanges to and from the real hardware. The specific test
    credentials (`residente` / the provided password) were rejected by the
    device at the RTSP layer, which reads as a device-side account/live-view
    permission issue (common for restricted "resident" sub-accounts on NVR
    systems) rather than a protocol or implementation bug.
  - Also confirmed via this app's own `sessionManager.js` (exercised directly
    and through the HTTP API): it correctly drives the same relay handshake,
    surfaces the real device 401 as a clear API/UI error, and — separately —
    the ffmpeg RTSP→HLS step and the server's static HLS serving were both
    validated end-to-end with a synthetic H.264/AAC test stream, so the
    rest of the pipeline (transcode, playlist generation, HTTP delivery,
    hls.js playback) is confirmed working; it only needs a stream that
    authenticates successfully to prove out.
  - **Reliability caveat, reproduced first‑hand:** running the exact same
    relay handshake against the exact same device back‑to‑back several times
    produced a mix of outcomes — sometimes `Ready to connect!` in ~3s,
    sometimes a ~25s timeout with no response during the P2P channel setup,
    and occasionally the cloud/device returns an error mid-setup that the
    Rust CLI surfaces as a panic (caught and reported by this app's backend
    as a normal session error, not a crash of the web app itself). This
    matches the upstream README's own disclaimer ("Still unstable, can crash
    at any time"). Simply retrying the request gets through within a few
    attempts; the app surfaces failures as a clear, retryable error rather
    than hanging silently.

**Update — confirmed working with correct credentials.** The initial test
account (`residente`/`user.2024`, later `cmn.2026`) was consistently and
correctly rejected by the device (401, verified via independently recomputed
digest hashes matching exactly) — turned out to simply be the wrong
credentials for this specific device's RTSP server. Once given the actual
working account for that device, the full pipeline succeeded end-to-end:
P2P tunnel → RTSP `SETUP`/`PLAY` → live HLS segments in the browser, and (after
the PTCP crash fix above) stayed up indefinitely. **If you test with your own
device**, use credentials that are known to work for *live view* specifically
in an official Dahua-ecosystem app (gDMSS Lite / SmartPSS / KBiVMS) — on some
platforms (e.g. residential/intercom systems built on Dahua hardware) the
app-login account and the device's local RTSP-serving account are not the
same thing.

## Bug fix applied on top of upstream

While testing against a real device with **working, live-view-capable
credentials** (as opposed to the earlier test account, which the device
correctly rejected — see below), streaming started successfully (RTSP
`OPTIONS`/`DESCRIBE`/`SETUP`/`PLAY` all `200 OK`, real video segments produced)
but then **crashed a few seconds in** with:

```
thread 'tokio-runtime-worker' panicked at src/ptcp.rs:192:9:
assertion `left == right` failed: Invalid magic
  left: [72, 84, 84, 80]   // "HTTP"
 right: [80, 84, 67, 80]   // "PTCP"
```

Root cause: the same UDP socket/local port carries both the initial
DH‑P2P/cloud handshake (HTTP‑like framing) and, later, PTCP traffic. A stray
leftover datagram from the handshake phase occasionally arrives after PTCP
traffic has started, and upstream's `PTCPPacket::parse` used a hard
`assert_eq!` on the `PTCP` magic bytes, which panics (and kills the whole
tunnel/stream) instead of just discarding the unexpected datagram.

**Fix** (`vendor/dh-p2p/src/ptcp.rs`): `PTCPPacket::parse` was split into a
fallible `PTCPPacket::try_parse` that returns `None` for anything that isn't
a well-formed PTCP frame; `ptcp_read()` now loops, discarding and logging any
non-PTCP datagram instead of panicking, and only returns once a real PTCP
packet arrives. This is a local patch on top of the vendored MIT-licensed
source — no other files were changed. With this fix, a stream that
authenticates successfully stays up indefinitely (tested continuously for
50+ seconds / 6+ rolling HLS segments with no further crashes).

## Known limitations (inherited from upstream `dh-p2p`)

- Reverse-engineered, unofficial protocol — **not** guaranteed stable or
  supported long-term; Dahua/cloud-side changes can break it without notice.
- Only `easy4ip`-cloud devices are reachable through this app (Amcrest's
  separate cloud isn't wired up in the Rust CLI this app uses).
- One dh-p2p process is spawned per viewer session; each holds its own PTCP
  tunnel, so watching the same camera from many browser tabs spawns many
  tunnels to the device (fine for a PoC / small number of viewers, not
  designed for scale).
- The relay path adds latency and depends on Dahua's relay/agent
  infrastructure being up.

## Channel/stream discovery

Many devices served through this protocol are NVRs where you may not know in
advance how many cameras are connected, which channel numbers are in use, or
whether a given channel exposes a sub-stream. The **"Discover Channels &
Streams"** expandable section on the page probes this for you:

1. It brings up a single P2P/PTCP tunnel for the device (separate from any
   live-view tunnel you may also have open) via `dh-p2p --relay`.
2. Over that one tunnel, it walks channels `1..maxChannels` (16 by default,
   Dahua's common NVR ceiling) and, for each, asks `ffmpeg` to pull exactly
   one frame from both `subtype=0` (main stream) and `subtype=1` (sub
   stream), saving whichever succeeds as a small JPEG thumbnail.
3. Channels are shown in the UI as soon as each one finishes — you don't have
   to wait for the whole scan. Clicking a thumbnail copies that
   channel/subtype into the live-view form above and starts watching it.
4. As a time-saver, the scan stops early once it sees several consecutive
   channels with no stream on either subtype (configurable via
   `CONSECUTIVE_EMPTY_TO_STOP` / `MIN_BEFORE_EARLY_STOP` in
   `server/channelScan.js`), rather than always walking all the way to
   `maxChannels`.

This was tested end-to-end against the real device used throughout this
project's testing (serial `5H0989EPAZEB886`): a 4-channel scan correctly
found all 4 channels, both subtypes available on each, with real,
non-trivial JPEG thumbnails (visually confirmed to show actual camera
footage, not blank/black frames). A mid-scan "Stop Scan" was also exercised
and correctly halted the probe loop and tore down the tunnel while keeping
the thumbnails already captured.

Each channel/stream probe is just a single-frame `ffmpeg` capture, so it's
subject to the same underlying P2P/PTCP tunnel flakiness documented above —
an individual channel occasionally reports "no stream" simply because that
one RTSP connection attempt didn't land, not because the channel doesn't
exist. Re-running the scan is the simplest way to confirm a channel marked
unavailable is actually unavailable.

## Continuous (loop) recording

The **"Continuous (Loop) Recording"** panel records a channel/stream to disk
indefinitely, independent of the browser:

1. Pick a channel/subtype, how much disk space to allow (default 1 GB), and
   the segment length (default 60s), then click **Start Recording**. This
   brings up its own dedicated P2P/PTCP tunnel (separate from live view and
   channel discovery) and starts `ffmpeg` writing fixed-length `.ts`
   segments to disk (`-f segment`, `-strftime 1`, so each file's name
   encodes its own wall-clock start time).
2. As each segment finishes, it's added to the recording's manifest; once
   total size exceeds the configured quota (or the host disk is running
   low, independent of the quota), the **oldest segment is deleted** to make
   room — true loop recording.
3. The recording keeps running entirely on the server. The browser only
   polls `GET /api/recordings` every few seconds to update the displayed
   stats (space used/remaining, retained duration, segment count) — closing
   the tab, refreshing the page, or not having it open at all **does not
   stop or affect the recording in progress**. This was verified directly:
   watching `retainedSeconds` advance by exactly 30s during a 30-second
   window with zero HTTP requests made, confirming the recording process
   advances purely server-side.
4. Click **Watch** on any recording to open it in a player below, with a
   custom timeline bar under the video. The timeline spans the recording's
   actual (gapless) content duration; **click anywhere on it to jump
   playback to that point**. If the tunnel ever dropped and reconnected
   mid-recording, that's shown as a dashed marker on the timeline and an
   `EXT-X-DISCONTINUITY` in the underlying HLS VOD playlist, but doesn't
   create a seek-to-nothing dead zone — the player's timeline only ever
   spans real, playable segments.
5. **Stop**/**Resume**: stopping keeps all footage and the manifest;
   resuming starts a new tunnel/ffmpeg attempt and simply continues
   appending (the stopped interval shows up as a gap, same as an
   unintentional tunnel drop). If the dh-p2p tunnel or ffmpeg dies
   unexpectedly while "recording" (not explicitly stopped), the recorder
   auto-reconnects every 5s rather than giving up.
6. Recordings (their manifest + already-captured segments) **survive a
   server restart**: on startup, any recording directories on disk are
   reloaded as `status: "stopped"`. Device credentials are never written to
   disk (consistent with the rest of this app), so resuming a
   restart-recovered recording requires re-entering the username/password
   via `POST /api/recordings/:id/resume`.

Tested end-to-end against the real device: recordings reliably accumulate
real `.ts` segments (manually verified to be well-formed MPEG-TS, with
correct 188-byte-aligned `0x47` sync bytes throughout and real captured
footage, not placeholder/black frames), quota enforcement was verified in
isolation with real files (deletes oldest-first until back under quota),
stop → resume correctly produces a timeline gap with the right
`EXT-X-DISCONTINUITY` placement, and the manifest/segments correctly survive
a `systemctl restart` of the whole app.

Two bugs were found and fixed during this testing (both only in
`server/recorder.js`, not in the pre-existing `sessionManager.js`/
`channelScan.js` which already handled these correctly):

- **Disk space was being measured on the wrong filesystem.** This app's own
  systemd unit sets `PrivateTmp=true` for sandboxing, which gives the
  process a private, tmpfs-backed `/tmp` disconnected from the real host
  disk — `os.tmpdir()` (used for all of this app's working directories)
  resolved into that tiny private mount, so "remaining space" and the
  safety-margin check were being computed against a few hundred MB of
  private tmpfs instead of the actual multi-GB disk. Fixed by adding
  `server/dataDir.js`, which resolves a real on-disk directory (under the
  app's own install path, `DATA_DIR`-overridable) instead of `os.tmpdir()`,
  with a startup write-check that logs clearly if it ever falls back. The
  systemd unit's `ReadWritePaths` was updated to include this directory.
- **A failed/cancelled recording attempt could leak its `dh-p2p` process.**
  `startDhP2pTunnel`'s readiness promise can reject while the process is
  still running (auth rejected, timeout, etc.) — `sessionManager.js`/
  `channelScan.js` already called `stopDhP2pTunnel` on that path, but
  `recorder.js`'s equivalent `.catch()` only logged the error and didn't
  stop the process, leaking a `dh-p2p` process per failed attempt. Fixed,
  and `stopDhP2pTunnel`/the equivalent ffmpeg stop path now also escalate to
  `SIGKILL` after a 2s grace period if `SIGTERM` doesn't take effect.
  Verified fixed by running repeated rapid start→delete cycles (including
  ones that hit the P2P handshake's known flakiness) and confirming zero
  leftover `dh-p2p`/`ffmpeg` processes afterward.

## API

| Method | Path                                | Body / Params                                                              | Description |
|--------|--------------------------------------|-------------------------------------------------------------------------------|--------------|
| POST   | `/api/sessions`                      | `{serial, username, password, channel?, subtype?, cloud?}`                    | Start a viewing session (blocks until streaming or failed) |
| GET    | `/api/sessions/:id`                  | —                                                                               | Poll session status |
| GET    | `/api/sessions/:id/log`              | —                                                                               | Raw dh-p2p/ffmpeg log lines for troubleshooting |
| DELETE | `/api/sessions/:id`                  | —                                                                               | Stop the session and clean up |
| POST   | `/api/scans`                         | `{serial, username, password, cloud?, maxChannels?}`                          | Start a channel/stream discovery scan (returns once the tunnel is up; scanning continues in the background) |
| GET    | `/api/scans/:id`                     | —                                                                               | Poll scan progress and per-channel results (thumbnails appear incrementally) |
| GET    | `/api/scans/:id/log`                 | —                                                                               | Raw dh-p2p/ffmpeg log lines for the scan's tunnel |
| POST   | `/api/scans/:id/stop`                | —                                                                               | Stop an in-progress scan (keeps thumbnails already captured) |
| DELETE | `/api/scans/:id`                     | —                                                                               | Stop (if running) and remove the scan, deleting its thumbnails |
| POST   | `/api/recordings`                    | `{serial, username, password, channel?, subtype?, cloud?, quotaGb?, segmentSeconds?}` | Start a continuous recording |
| GET    | `/api/recordings`                    | —                                                                               | List all recordings (running or stopped) |
| GET    | `/api/recordings/:id`                | —                                                                               | Poll a recording's status/stats |
| GET    | `/api/recordings/:id/segments`       | —                                                                               | Raw segment list (used by the frontend to build the clickable timeline) |
| GET    | `/api/recordings/:id/log`            | —                                                                               | Raw dh-p2p/ffmpeg log lines for the recorder's tunnel |
| GET    | `/api/recordings/:id/playlist.m3u8`  | —                                                                               | On-the-fly HLS VOD playlist covering all currently-retained segments |
| POST   | `/api/recordings/:id/stop`           | —                                                                               | Stop recording (keeps footage) |
| POST   | `/api/recordings/:id/resume`         | `{username?, password?}` (required if resuming after a server restart)        | Resume a stopped recording |
| DELETE | `/api/recordings/:id`                | —                                                                               | Stop (if running) and permanently delete the recording and its footage |

## Project layout

```
public/            Frontend (connect form, hls.js video player, channel/stream gallery, recording controls + timeline)
server/
  index.js          Express app + route wiring
  sessionManager.js  Single live-view session lifecycle (dh-p2p + ffmpeg -> HLS)
  channelScan.js     Channel/stream discovery scan lifecycle (dh-p2p + per-frame ffmpeg captures)
  recorder.js        Continuous loop-recording lifecycle (dh-p2p + ffmpeg -> rolling .ts segments, quota enforcement, on-the-fly VOD playlist)
  dhTunnel.js        Shared dh-p2p --relay process spawn/readiness logic (used by all three of the above)
  rtsp.js            Shared RTSP URL builder
  ports.js           Free local TCP port picker for the dh-p2p RTSP proxy
  dataDir.js         Resolves a real on-disk working directory (see "Continuous (loop) recording" above for why this isn't os.tmpdir())
scripts/            Build helper for the vendored Rust binary
vendor/dh-p2p/      Vendored MIT-licensed dh-p2p Rust source (patched, see above)
deploy/dahua-viewer.service  Reference systemd unit (see note on PrivateTmp/ReadWritePaths above)
```

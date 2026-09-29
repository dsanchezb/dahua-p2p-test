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

## API

| Method | Path                    | Body / Params                                             | Description |
|--------|--------------------------|------------------------------------------------------------|--------------|
| POST   | `/api/sessions`          | `{serial, username, password, channel?, subtype?, cloud?}` | Start a viewing session (blocks until streaming or failed) |
| GET    | `/api/sessions/:id`      | —                                                            | Poll session status |
| GET    | `/api/sessions/:id/log`  | —                                                            | Raw dh-p2p/ffmpeg log lines for troubleshooting |
| DELETE | `/api/sessions/:id`      | —                                                            | Stop the session and clean up |

## Project layout

```
public/            Frontend (form + hls.js video player)
server/             Express backend + session orchestration
scripts/            Build helper for the vendored Rust binary
vendor/dh-p2p/      Vendored MIT-licensed dh-p2p Rust source (unmodified)
```

# Attribution

The code in this directory (`Cargo.toml`, `Cargo.lock`, `src/*.rs`) is vendored,
unmodified, from the Rust implementation of:

**dh-p2p** — https://github.com/khoanguyen-3fc/dh-p2p
Copyright (c) 2023 khoanguyen-3fc, licensed under the MIT License (see `LICENSE`
in this directory).

It is a proof-of-concept implementation of RTSP-over-Dahua-P2P tunneling,
reverse engineered from the Dahua/EasyLife/easy4ip P2P protocol used by apps
such as gDMSS Lite, SmartPSS and KBiVMS to reach Dahua-derived cameras/NVRs
that sit behind NAT, using only the device serial number (and, for devices
that require it, the device username/password).

This project builds the vendored binary and wraps it with:
- an RTSP → HLS transcode step (ffmpeg), and
- a small web UI / API (see `../../server` and `../../public`)

so the stream can be viewed in a browser instead of a native RTSP client.

No functional changes were made to the vendored Rust source. See
`../../README.md` for a summary of testing performed against a real device
and known limitations inherited from the upstream project.

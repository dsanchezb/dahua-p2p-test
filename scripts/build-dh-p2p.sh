#!/usr/bin/env bash
# Builds the vendored dh-p2p Rust binary (release profile) used by the
# backend to establish the Dahua P2P/PTCP tunnel and expose a local RTSP
# proxy for a given camera serial number.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/dh-p2p"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo (Rust toolchain) not found in PATH. Install Rust (https://rustup.rs) and retry." >&2
  exit 1
fi

echo "Building dh-p2p (release) from $VENDOR_DIR ..."
(cd "$VENDOR_DIR" && cargo build --release)

BIN_PATH="$VENDOR_DIR/target/release/dh-p2p"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "error: build finished but binary not found at $BIN_PATH" >&2
  exit 1
fi

echo "Built: $BIN_PATH"

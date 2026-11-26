#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v cargo &> /dev/null; then
  echo "Rust/Cargo not found. Install it first with:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

if ! command -v cargo-tauri &> /dev/null; then
  echo "Installing Tauri CLI v2..."
  cargo install tauri-cli --version "^2.0"
fi

if [[ "${1:-}" == "--universal" ]]; then
  echo "Building Universal macOS app & .dmg (Apple Silicon + Intel)..."
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  cargo tauri build --target universal-apple-darwin
  OUT_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
else
  echo "Building native Apple Silicon (ARM64) macOS app & .dmg..."
  cargo tauri build
  OUT_DIR="src-tauri/target/release/bundle"
fi

if [[ -d "${OUT_DIR}/macos/iD Interface.app" ]]; then
  xattr -cr "${OUT_DIR}/macos/iD Interface.app" 2>/dev/null || true
fi

echo ""
echo "Done! Your macOS app & DMG are in:"
echo "  ${OUT_DIR}/macos/iD Interface.app"
echo "  ${OUT_DIR}/dmg/"

#!/usr/bin/env bash
# Regenerates the Chrome icon sizes from the source logo.
# Uses macOS sips, so this must run on macOS.
set -euo pipefail

cd "$(dirname "$0")/.."

for size in 16 48 128; do
  sips -z "$size" "$size" logo/logo.png --out "logo/logo-${size}.png"
done

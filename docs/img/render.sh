#!/usr/bin/env bash
# Render every sheet in this directory to a PNG of the same name at 2x, and
# crop it. The chapters and security-model.md reference the PNGs.
set -euo pipefail
cd "$(dirname "$0")"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in *.html; do
	out="${f%.html}.png"
	"$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
		--window-size=1120,1800 --screenshot="$out" "file://$PWD/$f" 2>/dev/null
	python3 autocrop.py "$out"
done

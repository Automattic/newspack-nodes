#!/usr/bin/env bash
#
# test-render-diagram.sh — tests for the docs/img sheet renderer.
#
# A stub stands in for Chrome: --dump-dom answers a measured height, and
# --screenshot writes a three-row PNG whose bottom two rows are background, so
# the real autocrop.py beside the renderer has something to crop. The stub logs
# every screenshot it takes, which is how a case knows what was rendered.

set -u
cd "$( dirname "$0" )" || exit 2
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found on PATH"; exit 2; }

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

cat > "$tmp/chrome" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
	case "$arg" in
		--dump-dom) echo '<html><head><title>1234</title></head></html>'; exit 0 ;;
		--window-size=*) size="${arg#--window-size=}" ;;
		--screenshot=*) png="${arg#--screenshot=}" ;;
	esac
done
echo "$(basename "$png") $size" >> "$STUB_LOG"
python3 -I - "$png" <<'PY'
import struct, sys, zlib
raw = b'\x00' + bytes([0] * 6) + (b'\x00' + bytes([255] * 6)) * 2
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n'
    + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 3, 8, 2, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
PY
STUB
chmod +x "$tmp/chrome"

# plugin — a fresh plugin tree carrying the renderer and two sheets.
plugin() {
	local dir="$tmp/$1"
	mkdir -p "$dir/scripts" "$dir/docs/img"
	cp render-diagram.sh autocrop.py "$dir/scripts/"
	for sheet in alpha beta; do
		echo "<p>$sheet</p>" > "$dir/docs/img/$sheet.html"
		touch -t 202001010000 "$dir/docs/img/$sheet.html"
	done
	: > "$dir/log"
	echo "$dir"
}

# render DIR [ARGS…] — run DIR's renderer against the stub; prints its status.
render() {
	local dir="$1"; shift
	( cd "$dir" && CHROME="$tmp/chrome" STUB_LOG="$dir/log" \
		bash scripts/render-diagram.sh "$@" >"$dir/out" 2>&1 )
	echo $?
}

# check LABEL ACTUAL EXPECTED
check() {
	if [[ "$2" == "$3" ]]; then
		echo "✓ $1"
	else
		echo "✗ $1: expected '$3', got '$2'"
		fail=1
	fi
}

# height PNG — the IHDR height.
height() {
	python3 -I -c 'import struct,sys; print(struct.unpack(">I", open(sys.argv[1],"rb").read()[20:24])[0])' "$1"
}

dir="$( plugin all )"
status="$( render "$dir" )"
check "no argument exits 0" "$status" 0
check "no argument renders every sheet in docs/img" \
	"$( sort "$dir/log" | tr '\n' ' ' )" "alpha.png 1120,1234 beta.png 1120,1234 "
check "every render is cropped by the autocrop beside the renderer" \
	"$( height "$dir/docs/img/alpha.png" ) $( height "$dir/docs/img/beta.png" )" "1 1"
check "no probe is left behind" "$( find "$dir/docs/img" -name '.render-probe-*' | wc -l | tr -d ' ' )" 0

dir="$( plugin named )"
status="$( render "$dir" docs/img/beta.html )"
check "a named sheet exits 0" "$status" 0
check "a named sheet renders that sheet alone" "$( cat "$dir/log" )" "beta.png 1120,1234"

dir="$( plugin missing )"
status="$( render "$dir" docs/img/gamma.html )"
check "a missing sheet exits 1" "$status" 1
check "a missing sheet renders nothing" "$( wc -l < "$dir/log" | tr -d ' ' )" 0

dir="$( plugin empty )"
rm "$dir"/docs/img/*.html
status="$( render "$dir" )"
check "no argument and no sheets exits 1" "$status" 1

exit "$fail"

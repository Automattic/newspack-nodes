#!/usr/bin/env bash
# Render docs/img/<name>.html to <name>.png at the size the sheet actually is.
#
# With no argument it renders every sheet in this plugin's docs/img; given
# pages, it renders those alone.
#
# Headless Chrome screenshots the VIEWPORT, so the height is measured before
# the capture rather than guessed: a probe copy of the page reports its own
# scrollHeight through --dump-dom, and that height becomes the window. Every
# sheet is a fixed 1120px and every committed PNG is 2240 wide, so the scale
# factor is 2.
#
# The probe is written BESIDE the page rather than in a temp dir, so it
# resolves base.css and any other relative asset exactly as the capture does.
# A probe that rendered unstyled would measure a much taller page and pad the
# capture with blank space.
set -euo pipefail

CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
WIDTH=1120
SCALE=2
here=$(cd "$(dirname "$0")" && pwd)

[ -x "$CHROME" ] || { echo "${0##*/}: no Chrome at $CHROME (set CHROME=)" >&2; exit 1; }

if [ $# -eq 0 ]; then
	shopt -s nullglob
	set -- "$here"/../docs/img/*.html
	[ $# -ge 1 ] || { echo "${0##*/}: no sheets in $here/../docs/img" >&2; exit 1; }
fi

for page in "$@"; do
	dir=$(cd "$(dirname "$page")" && pwd)
	name=$(basename "$page" .html)
	src="$dir/$name.html"
	png="$dir/$name.png"
	probe="$dir/.render-probe-$name.html"

	[ -f "$src" ] || { echo "${0##*/}: no such page: $src" >&2; exit 1; }
	trap 'rm -f "$probe"' EXIT

	# On `load`, not during parse: the capture honours the time budget, so a
	# height read earlier would measure a page the screenshot never shows.
	# The window height includes rows that are not viewport; add them back.
	{
		cat "$src"
		printf '<title></title><script>addEventListener("load",()=>{document.title=document.documentElement.scrollHeight+outerHeight-innerHeight})</script>'
	} > "$probe"

	height=$("$CHROME" --headless --disable-gpu --hide-scrollbars \
		--window-size="$WIDTH,800" --virtual-time-budget=4000 \
		--dump-dom "file://$probe" |
		sed -n 's/.*<title[^>]*>\([0-9]\{1,\}\)<\/title>.*/\1/p' | head -1)
	rm -f "$probe"
	trap - EXIT

	[ -n "$height" ] || { echo "${0##*/}: $name: could not measure height" >&2; exit 1; }

	"$CHROME" --headless --disable-gpu --hide-scrollbars \
		--force-device-scale-factor="$SCALE" \
		--window-size="$WIDTH,$height" --virtual-time-budget=4000 \
		--screenshot="$png" "file://$src"

	# Chrome exits 0 when it cannot write the file, so the only proof the
	# render happened is a PNG newer than the page it came from.
	[ "$png" -nt "$src" ] || { echo "${0##*/}: $name: no PNG written" >&2; exit 1; }

	# The rows below the viewport come out blank; crop them off.
	python3 -I "$here/autocrop.py" "$png" >/dev/null

	echo "$name.png  ${WIDTH}x${height} window @${SCALE}x, cropped"
done

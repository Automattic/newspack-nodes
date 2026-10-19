#!/usr/bin/env bash
#
# test-bump-version.sh — tests for the shared version bump's DROP_IN knob.
#
# A plugin whose drop-in ships as its own release asset names it in DROP_IN,
# and the bump moves the drop-in's `Version:` header with the plugin's. A
# drop-in the bump cannot rewrite refuses the whole bump before anything is
# edited, because a header left behind tells a site the wrong release.

set -u
cd "$( dirname "$0" )" || exit 2

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

OLD=6.6.6
NEW=7.7.7
DROP_IN_OLD=0.1.0

# fixture NAME DROP_IN_SHAPE [DROP_IN_VERSION] — a throwaway plugin whose
# wrapper names a drop-in: `header` carries a version line and a second,
# indented one that is no header, `headless` carries none, and `missing`
# leaves the file out.
fixture() {
	local dir="$tmp/$1"
	mkdir -p "$dir/scripts/lib" "$dir/mu-plugins"
	cp ./lib/bump-version.sh "$dir/scripts/lib/"
	cat > "$dir/scripts/bump-version.sh" <<-'SH'
		#!/bin/sh
		set -e
		SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
		PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
		PLUGIN_FILE="kea.php"
		VERSION_CONST="KEA_VERSION"
		DROP_IN="mu-plugins/00-kea.php"
		. "$SCRIPT_DIR/lib/bump-version.sh"
	SH
	chmod +x "$dir/scripts/bump-version.sh"
	printf "<?php\n/**\n * Plugin Name: Kea\n * %s %s\n */\n\\\\define( 'KEA_VERSION', '%s' );\n" 'Version:' "$OLD" "$OLD" > "$dir/kea.php"
	case "$2" in
		header) printf "<?php\n/**\n * Plugin Name: Kea Drop-in\n * %s %s\n */\n//  * %s 2.0 of the wire format\n" 'Version:' "${3:-$DROP_IN_OLD}" 'Version:' > "$dir/mu-plugins/00-kea.php" ;;
		headless) printf "<?php\n// no header\n" > "$dir/mu-plugins/00-kea.php" ;;
	esac
	echo "$dir"
}

check() {
	local label="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected '$expected', got '$actual'"
		fail=1
	fi
}

version_of() { sed -n 's/^ \* Version: *//p' "$1"; }

for from in "$DROP_IN_OLD" 1 0.6.3-rc.1; do
	dir="$( fixture "moves-$from" header "$from" )"
	"$dir/scripts/bump-version.sh" "$NEW" >"$tmp/out" 2>&1
	check "a drop-in at $from: the bump exits 0" 0 "$?"
	check "a drop-in at $from: its header moves with the plugin" "$NEW" "$( version_of "$dir/mu-plugins/00-kea.php" )"
	check "a drop-in at $from: the plugin header moves" "$NEW" "$( version_of "$dir/kea.php" )"
	check "a drop-in at $from: a line that is no header stays" 1 "$( grep -c 'Version: 2.0 of the wire format' "$dir/mu-plugins/00-kea.php" )"
done

for shape in headless missing; do
	dir="$( fixture "$shape" "$shape" )"
	if "$dir/scripts/bump-version.sh" "$NEW" >"$tmp/out" 2>&1; then
		echo "✗ a $shape drop-in must refuse the bump"
		fail=1
	else
		echo "✓ a $shape drop-in refuses the bump"
	fi
	check "a $shape drop-in leaves the plugin untouched" "$OLD" "$( version_of "$dir/kea.php" )"
done

exit "$fail"

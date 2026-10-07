#!/bin/sh
#
# sync-shared-scripts.sh — refresh this plugin's copy of the shared tooling.
#
# newspack-nodes holds the authoritative copies; every other plugin carries a
# vendored copy so a standalone clone (no sibling checkout) still has working
# hooks. This runs from pre-commit, where the sibling normally exists, and
# stages anything it refreshes so the update rides along with the commit.
#
# Every write is temp-then-rename: cp in place reuses the inode, and a running
# shell re-reads its own script from a byte offset, so overwriting this file or
# the pre-commit hook that invoked it corrupts the parse mid-run. Renaming
# gives a fresh inode and leaves the open descriptor on the old one.
#
# Two phases on top of that: with no argument this refreshes ONLY itself and
# re-execs, so the rest of the pass runs the new logic rather than the version
# that happened to be vendored.
#
# Silence when the sibling is absent is deliberate, not an oversight: that is
# the standalone case, and the committed copy is what should be used there.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd || exit 1)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
SUBSTRATE_DIR="$PLUGIN_DIR/../newspack-nodes"
SELF="sync-shared-scripts.sh"

# Neither this script, which phase 1 owns, nor a test-*.sh or pre-push.local.
SHARED="reorder-node-methods.php reorder-node-methods.js coverage-gate-js.mjs
	coverage-gate.py lint-comments.mjs lint-comments.php fix-blank-lines.php
	lint-contract.mjs lint-styles.mjs lint-wp-pin.mjs
	check-substrate-floor.sh phpstan-substrate-floor.php phpstan-floor.neon
	pre-commit commit-msg pre-push .shellcheckrc lint-docs.sh
	render-diagram.sh autocrop.py"

[ -d "$SUBSTRATE_DIR/scripts" ] || exit 0

# In the substrate itself there is nothing to copy.
[ "$(cd "$SUBSTRATE_DIR" && pwd || exit 1)" != "$PLUGIN_DIR" ] || exit 0

# refresh SRC DEST RELPATH — copy when different, stage it, report it.
refresh() {
	cmp -s "$1" "$2" && return 0
	cp -p "$1" "$2.tmp.$$"
	mv -f "$2.tmp.$$" "$2"
	git -C "$PLUGIN_DIR" add "$3"
	echo "sync-shared-scripts: refreshed $3"
}

if [ -z "$1" ]; then
	# Phase 1: replace ourselves atomically, then re-exec so phase 2 is the
	# new logic.
	refresh "$SUBSTRATE_DIR/scripts/$SELF" "$SCRIPT_DIR/$SELF" "scripts/$SELF"
	exec "$SCRIPT_DIR/$SELF" run
fi

# Phase 2: everything else, running the just-updated logic.
for f in $SHARED; do
	src="$SUBSTRATE_DIR/scripts/$f"
	[ -f "$src" ] || continue
	# The JS reorder twin needs a src/ tree and @babel/parser to run at all.
	case "$f" in
		reorder-node-methods.js)
			[ -d "$PLUGIN_DIR/src" ] || continue ;;
		# The renderer and its cropper serve docs/img sheets alone.
		render-diagram.sh|autocrop.py)
			[ -d "$PLUGIN_DIR/docs/img" ] || continue ;;
	esac
	refresh "$src" "$SCRIPT_DIR/$f" "scripts/$f"
done

mkdir -p "$SCRIPT_DIR/lib"
for src in "$SUBSTRATE_DIR"/scripts/lib/*.sh "$SUBSTRATE_DIR"/scripts/lib/*.mjs; do
	[ -f "$src" ] || continue
	f=$(basename "$src")
	refresh "$src" "$SCRIPT_DIR/lib/$f" "scripts/lib/$f"
done


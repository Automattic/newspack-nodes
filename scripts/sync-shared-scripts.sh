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

# Everything except this script, which phase 1 owns.
SHARED="reorder-node-methods.php reorder-node-methods.js coverage-gate-js.mjs
	coverage-gate.py lint-comment-length.mjs lint-comment-length.php
	test-coverage-gate.sh test-reorder-node-methods.sh
	pre-commit commit-msg lint-docs.sh"

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
	# A plugin with no src/ tree has nothing for the JS reorder tool, and no
	# @babel/parser to run it with; skip rather than vendor a dead script.
	# Its test goes with it — half the cases shell out to that twin, so
	# vendoring the test alone leaves a suite that cannot pass.
	case "$f" in
		reorder-node-methods.js|test-reorder-node-methods.sh)
			[ -d "$PLUGIN_DIR/src" ] || continue ;;
	esac
	refresh "$src" "$SCRIPT_DIR/$f" "scripts/$f"
done

mkdir -p "$SCRIPT_DIR/lib"
for src in "$SUBSTRATE_DIR"/scripts/lib/*.sh; do
	[ -f "$src" ] || continue
	f=$(basename "$src")
	refresh "$src" "$SCRIPT_DIR/lib/$f" "scripts/lib/$f"
done


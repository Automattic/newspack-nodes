#!/bin/bash
#
# Sync shared hooks and utilities from this plugin (canonical) to sibling
# plugins that need the same React/JS utilities.
#
# Canonical sources live in this plugin's src/shared/. Run after editing
# any file in src/shared/ — the npm `build` script chains us first
# automatically.
#
# Adding a new sibling: add another argument to each sync() call.
# Adding a new file: write it under src/shared/{hooks,utils}/, then add
# a `sync` line below.
#

set -euo pipefail
cd "$(dirname "$0")"

HOOKS=src/shared/hooks
UTILS=src/shared/utils
COMPONENTS=src/shared/components

HEADER="// Synced from src/shared/ by sync-shared.sh — edit the canonical source, not this copy."

sync() {
	local src="$1"; shift
	local name; name=$(basename "$src")
	for dest in "$@"; do
		mkdir -p "$dest"
		# Write to a per-process tmp file then atomic-rename into place. The
		# old two-step (printf > then cat >>) raced with sibling-plugin jest
		# coverage runs reading the same path — Jest would hit a half-written
		# file under `run-coverage` (parallel mode) and fail with parse errors.
		# `mv` is atomic for same-filesystem renames, so concurrent readers
		# see either the old contents or the new ones, never a torn write.
		local tmp="$dest/.$name.$$.tmp"
		{ printf '%s\n' "$HEADER"; cat "$src"; } > "$tmp"
		mv "$tmp" "$dest/$name"
	done
}

# --- Hooks ---

sync "$HOOKS/usePageVisibility.js" \
	../newspack-event-logger-nodes/src/shared/hooks/

sync "$HOOKS/useAdminMenuWidth.js" \
	../newspack-event-logger-nodes/src/shared/hooks/

sync "$HOOKS/useVirtualization.js" \
	../newspack-event-logger-nodes/src/shared/hooks/

sync "$HOOKS/useTimeChart.js" \
	../newspack-event-logger-nodes/src/shared/hooks/

# --- Utilities ---

sync "$UTILS/commandClient.js" \
	../newspack-event-logger-nodes/src/shared/utils/

sync "$UTILS/unwrapCommandResponse.js" \
	../newspack-event-logger-nodes/src/shared/utils/

sync "$UTILS/formatUtils.js" \
	../newspack-event-logger-nodes/src/shared/utils/

sync "$UTILS/fnv1a.js" \
	../newspack-event-logger-nodes/src/shared/utils/

# --- Components ---

sync "$COMPONENTS/ConnectionBanner.js" \
	../newspack-event-logger-nodes/src/shared/components/

sync "$COMPONENTS/ConnectionBanner.scss" \
	../newspack-event-logger-nodes/src/shared/components/

echo "Shared files synced."

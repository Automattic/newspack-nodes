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

HEADER="// Synced from src/shared/ by sync-shared.sh — edit the canonical source, not this copy."

sync() {
	local src="$1"; shift
	local name; name=$(basename "$src")
	for dest in "$@"; do
		mkdir -p "$dest"
		printf '%s\n' "$HEADER" > "$dest/$name"
		cat "$src" >> "$dest/$name"
	done
}

# --- Hooks ---

sync "$HOOKS/usePageVisibility.js" \
	../newspack-event-logger-nodes/src/shared/hooks/

sync "$HOOKS/useMessageStream.js" \
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

echo "Shared files synced."

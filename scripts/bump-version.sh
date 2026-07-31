#!/bin/sh
#
# bump-version.sh — update the version across this plugin.
#
# Usage:
#   ./scripts/bump-version.sh <new-version>
#
# The shared flow lives in scripts/lib/bump-version.sh; this file is only the
# per-plugin knobs.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd || exit 1)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck disable=SC2034  # consumed by the sourced lib
SUBSTRATE_DIR="$PLUGIN_DIR/../newspack-nodes"

# shellcheck disable=SC2034  # consumed by the sourced lib
PLUGIN_FILE="newspack-nodes.php"
# shellcheck disable=SC2034
VERSION_CONST="NEWSPACK_NODES_VERSION"

# A jest test pins the build-kit banner to package.json, so it moves in step.
bump_extra() {
	sed -i '' "s/SUBSTRATE_VERSION = '[^']*'/SUBSTRATE_VERSION = '$1'/" src/build-kit/index.mjs
	echo "Updated src/build-kit/index.mjs (SUBSTRATE_VERSION)"
}

show_extra() {
	echo "build-kit:"
	grep "SUBSTRATE_VERSION = " src/build-kit/index.mjs
}

# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/bump-version.sh"

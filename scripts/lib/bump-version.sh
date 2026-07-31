#!/bin/sh
#
# bump-version.sh — the version bump every plugin shares.
#
# Sourced by each plugin's scripts/bump-version.sh, which sets the knobs and
# may define the optional hooks. Not executable on its own.
#
# The wrapper MUST set, before sourcing:
#   PLUGIN_DIR    absolute path to the plugin root
#   PLUGIN_FILE   main plugin PHP file, relative to PLUGIN_DIR
#   VERSION_CONST the PHP constant carrying the version
#
# The wrapper MAY define:
#   bump_extra VERSION   plugin-specific rewrites (run inside PLUGIN_DIR)
#   show_extra           extra verification output
#   SUBSTRATE_PIN        release workflow path; repins the substrate when set
#
# Path assumption, deliberately the only one: the substrate is a SIBLING
# checkout of the plugin. Nothing here knows about dndocker's layout, so a
# standalone clone works the same as one inside the monorepo.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

die() { printf "${RED}Error: %s${NC}\n" "$1" >&2; exit 1; }
ok() { printf "${GREEN}%s${NC}\n" "$1"; }
warn() { printf "${YELLOW}%s${NC}\n" "$1"; }

[ -n "$PLUGIN_DIR" ] || die "PLUGIN_DIR not set by the wrapper"
[ -n "$PLUGIN_FILE" ] || die "PLUGIN_FILE not set by the wrapper"
[ -n "$VERSION_CONST" ] || die "VERSION_CONST not set by the wrapper"

[ $# -eq 1 ] || { echo "Usage: $0 <new-version>"; exit 1; }

NEW_VERSION="$1"

echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
	|| die "Invalid version format: $NEW_VERSION"

[ -d "$PLUGIN_DIR" ] || die "Plugin dir not found: $PLUGIN_DIR"

cd "$PLUGIN_DIR" || die "cannot enter $PLUGIN_DIR"

[ -f "$PLUGIN_FILE" ] || die "Plugin file not found: $PLUGIN_DIR/$PLUGIN_FILE"

CURRENT=$(grep " \* Version:" "$PLUGIN_FILE" | head -1 | sed 's/.*Version:[[:space:]]*//')
[ -n "$CURRENT" ] || die "Could not detect current version"
[ "$CURRENT" != "$NEW_VERSION" ] || die "Already at version $NEW_VERSION"

# A consumer's pin must be rewritable BEFORE anything is edited, so a missing
# pin aborts with the tree untouched rather than half-bumped.
if [ -n "$SUBSTRATE_PIN" ]; then
	# shellcheck source=/dev/null
	. "$SCRIPT_DIR/lib/bump-substrate-pin.sh"
	require_substrate_pin "$SUBSTRATE_PIN"
	# shellcheck disable=SC2153  # set by the wrapper
	SUBSTRATE_VERSION_TO_PIN=$(substrate_version "$SUBSTRATE_DIR")
fi

echo "Current: $CURRENT"
echo "New:     $NEW_VERSION"
echo ""

sed -i '' "s/\\( \\* Version:[[:space:]]*\\)[0-9][0-9.]*[0-9]/\\1$NEW_VERSION/" "$PLUGIN_FILE"
# Two shapes in the wild: define( 'X', '1.2.3' ) and const X = '1.2.3'.
sed -i '' "s/$VERSION_CONST', '[^']*'/$VERSION_CONST', '$NEW_VERSION'/" "$PLUGIN_FILE"
sed -i '' "s/$VERSION_CONST = '[^']*'/$VERSION_CONST = '$NEW_VERSION'/" "$PLUGIN_FILE"
grep -q "$VERSION_CONST.*'$NEW_VERSION'" "$PLUGIN_FILE" \
	|| die "$VERSION_CONST did not take the new version in $PLUGIN_FILE"
echo "Updated $PLUGIN_FILE"

if [ -f package.json ]; then
	npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null
	echo "Updated package.json + package-lock.json (npm version)"
fi

if [ -n "$SUBSTRATE_PIN" ]; then
	write_substrate_pin "$SUBSTRATE_PIN" "$SUBSTRATE_VERSION_TO_PIN"
	echo "Updated $SUBSTRATE_PIN (substrate pin)"
fi

if command -v bump_extra >/dev/null 2>&1; then
	bump_extra "$NEW_VERSION"
fi

echo ""
ok "Version updated to $NEW_VERSION"
echo ""

echo "Verification:"
echo "Header:"
grep " \* Version:" "$PLUGIN_FILE"
echo "Constant:"
grep "$VERSION_CONST" "$PLUGIN_FILE" | grep -F "'$NEW_VERSION'" | head -1
if [ -f package.json ]; then
	echo "package.json:"
	grep '"version"' package.json | head -1
fi
if [ -n "$SUBSTRATE_PIN" ]; then
	echo "Substrate pin:"
	show_substrate_pin "$SUBSTRATE_PIN"
fi
if command -v show_extra >/dev/null 2>&1; then
	show_extra
fi

echo ""
warn "Next: update CHANGELOG.md, commit, tag v$NEW_VERSION, push"

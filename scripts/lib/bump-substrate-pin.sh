#!/bin/sh
#
# bump-substrate-pin.sh — substrate pin shared by the nodes consumers.
#
# Sourced by bump-event-logger-nodes-version.sh and
# bump-intelligence-version.sh; not executable. Callers must define die().
#
# Both consumers build their bundles in CI against the tag pinned in
# release.yml. A stale pin still builds — it just inlines older shared code —
# so the workflow goes green while the zip ships pre-change assets. The two
# must pin identically, which is why this lives in one file: the same logic
# written twice is the drift that caused the bug it prevents.

SUBSTRATE_REPO="Automattic/newspack-nodes"

# substrate_version DIR — the tagged version of the newspack-nodes at DIR.
substrate_version() {
	_dir="$1"
	[ -f "$_dir/newspack-nodes.php" ] || die "No newspack-nodes checkout at $_dir"
	_version=$(grep " \* Version:" "$_dir/newspack-nodes.php" | head -1 | sed 's/.*Version:[[:space:]]*//')
	[ -n "$_version" ] || die "Could not detect newspack-nodes version in $_dir"
	git -C "$_dir" rev-parse -q --verify "refs/tags/v$_version" >/dev/null \
		|| die "newspack-nodes v$_version is not tagged; release and tag the substrate before its consumers"
	echo "$_version"
}

# require_substrate_pin FILE — die unless FILE has a substrate pin to rewrite.
require_substrate_pin() {
	[ -f "$1" ] || die "No release workflow at $1"
	awk -v repo="repository: $SUBSTRATE_REPO" '
		index( $0, repo ) { seen = 1; next }
		seen && /^ *ref: / { found = 1; exit }
		END { exit !found }
	' "$1" || die "No pinned $SUBSTRATE_REPO checkout in $1"
}

# write_substrate_pin FILE VERSION — repin ONLY the substrate checkout's ref.
write_substrate_pin() {
	sed -i '' "\\#repository: $SUBSTRATE_REPO#,/^ *ref: /s/^\\( *ref: \\).*\$/\\1v$2/" "$1"
}

# show_substrate_pin FILE — echo the pin in FILE, for verification output.
show_substrate_pin() {
	awk -v repo="repository: $SUBSTRATE_REPO" '
		index( $0, repo ) { seen = 1; next }
		seen && /^ *ref: / { print; exit }
	' "$1"
}

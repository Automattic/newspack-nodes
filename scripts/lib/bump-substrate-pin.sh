#!/bin/sh
#
# bump-substrate-pin.sh — substrate pin shared by the nodes consumers.
#
# Sourced by bump-version.sh when the plugin's wrapper sets SUBSTRATE_PIN;
# not executable. Callers must define die().
#
# Every consumer builds its bundles in CI against the substrate commit pinned
# in release.yml as `ref: <sha> # v<version>`. A stale pin still builds — it
# just inlines older shared code — so the workflow goes green while the zip
# ships pre-change assets. The pin names the commit rather than the tag because
# a tag can be moved after the pin is reviewed. Every consumer must pin
# identically, which is why this lives in one file: the same logic written
# twice would drift.

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

# substrate_commit DIR VERSION — the commit tag vVERSION names at DIR, refused
# unless origin carries that same tag and its origin/main holds the commit, so
# a pin CI cannot fetch is never written.
substrate_commit() {
	_dir="$1"
	_tag="refs/tags/v$2"
	_commit=$(git -C "$_dir" rev-parse -q --verify "$_tag^{commit}") \
		|| die "newspack-nodes v$2 is not tagged; release and tag the substrate before its consumers"
	_listing=$(git -C "$_dir" ls-remote origin "$_tag") \
		|| die "Could not read newspack-nodes tags from origin in $_dir"
	_pushed=$(printf '%s\n' "$_listing" | awk -v ref="$_tag" '$2 == ref { print $1 }')
	[ "$_pushed" = "$(git -C "$_dir" rev-parse "$_tag")" ] \
		|| die "newspack-nodes v$2 is not pushed to origin as tagged here; push the tag before pinning it"
	git -C "$_dir" merge-base --is-ancestor "$_commit" origin/main \
		|| die "newspack-nodes v$2 ($_commit) is not on origin/main; fetch origin, or tag a commit main holds"
	echo "$_commit"
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

# write_substrate_pin FILE COMMIT VERSION — repin ONLY the substrate checkout's
# ref, as the commit with the tag it came from beside it.
write_substrate_pin() {
	sed -i '' "\\#repository: $SUBSTRATE_REPO#,/^ *ref: /s/^\\( *ref: \\).*\$/\\1$2 # v$3/" "$1"
}

# show_substrate_pin FILE — echo the pin line in FILE, either the commit form
# or the bare `ref: vX.Y.Z` it replaced, for verification output.
show_substrate_pin() {
	awk -v repo="repository: $SUBSTRATE_REPO" '
		index( $0, repo ) { seen = 1; next }
		seen && /^ *ref: / { print; exit }
	' "$1"
}

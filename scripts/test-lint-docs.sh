#!/usr/bin/env bash
#
# test-lint-docs.sh — tests for the doc-drift lint's substrate-floor rule.
#
# Each case writes a throwaway consumer that declares a floor, in its plugin
# file or as a class constant under includes/, and an AGENTS.md naming one,
# and holds the lint to whether the two agree.

set -u
cd "$( dirname "$0" )" || exit 2
HERE=$PWD

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# A space in the path, so nothing downstream may assume a path is one word.
consumer="$tmp/lint docs/consumer"
mkdir -p "$consumer/includes" "$consumer/scripts/lib"
git -C "$consumer" init -q
cp "$HERE/lint-docs.sh" "$consumer/scripts/"
cp "$HERE/lib/substrate-floor.sh" "$consumer/scripts/lib/"

# spelt FLOOR — the plugin file spells the floor out.
spelt() {
	printf "<?php\n\\\\Newspack_Nodes\\\\Bootstrap::version_at_least( '%s', 'Kea' );\n" "$1" > "$consumer/kea.php"
	rm -f "$consumer/includes/class-plugin.php"
}

# held FLOOR — a class under includes/ holds the floor as NODES_FLOOR.
held() {
	printf '<?php\n' > "$consumer/kea.php"
	printf "<?php\nfinal class Plugin {\n\tpublic const NODES_FLOOR = '%s';\n}\n" "$1" > "$consumer/includes/class-plugin.php"
}

# undeclared — neither place declares a floor.
undeclared() {
	printf '<?php\n' > "$consumer/kea.php"
	rm -f "$consumer/includes/class-plugin.php"
}

# prose TEXT — the consumer's AGENTS.md.
prose() {
	printf '%s\n' "$1" > "$consumer/AGENTS.md"
}

# lint LABEL WANT_EXIT [TEXT] — run the lint, hold it to WANT_EXIT, and to
# holding TEXT when given.
lint() {
	local got
	( cd "$consumer" && bash scripts/lint-docs.sh ) > "$tmp/out" 2>&1
	got=$?
	if [ "$got" = "$2" ] && grep -qF -- "${3:-}" "$tmp/out"; then
		echo "✓ $1"
	else
		echo "✗ $1: expected exit $2, saying \"${3:-}\", got $got"
		sed 's/^/    /' "$tmp/out"
		fail=1
	fi
}

prose "Dormant below \`version_at_least( '7.41.3' )\`."
spelt 7.41.3
lint "prose naming the floor the plugin file spells out passes" 0
spelt 7.42.0
lint "prose naming another floor than the plugin file's fails" 1 "disagrees with the loader (7.42.0)"

held 7.41.3
lint "prose naming the floor a class constant holds passes" 0
held 7.43.5
lint "prose naming another floor than the class constant's fails" 1 "disagrees with the loader (7.43.5)"

undeclared
lint "a plugin declaring no floor passes whatever its prose names" 0

held 7.43.5
printf "<?php\nversion_at_least( '7.41.3' );\n" > "$consumer/kea.php"
lint "a floor the plugin file spells out wins over a class constant" 0

exit "$fail"

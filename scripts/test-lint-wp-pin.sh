#!/usr/bin/env bash
#
# test-lint-wp-pin.sh — tests for the @wordpress/* pin gate.
#
# The rule: every runtime `@wordpress/*` dependency is declared as an exact
# version, and package-lock.json resolves it to that same version. A caret
# lets `npm install` climb past the wp-N.N dist tag while the declaration
# still reads as the tag, and `npm ci` then builds against the climbed lock.
# devDependencies are tooling, not the API the browser hands us, and are not
# checked.

set -u
cd "$( dirname "$0" )" || exit 2
command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH"; exit 2; }

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# fixture NAME PACKAGE_JSON LOCK_PACKAGES — one throwaway project dir.
fixture() {
	local dir="$tmp/$1"
	mkdir -p "$dir"
	printf '%s' "$2" > "$dir/package.json"
	printf '{ "lockfileVersion": 3, "packages": { "": {}, %s } }' "$3" > "$dir/package-lock.json"
	echo "$dir"
}

# assert_flags LABEL DIR NEEDLE — the gate must exit 1 and report NEEDLE.
assert_flags() {
	local label="$1" dir="$2" needle="$3" out status
	out="$( node ./lint-wp-pin.mjs "$dir" 2>&1 )"; status=$?
	if [[ $status -eq 1 && "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 1 mentioning '$needle'; got exit $status:"
		echo "$out"
		fail=1
	fi
}

# assert_clean LABEL DIR — the gate must exit 0.
assert_clean() {
	local label="$1" dir="$2" out status
	out="$( node ./lint-wp-pin.mjs "$dir" 2>&1 )"; status=$?
	if [[ $status -eq 0 ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 0; got exit $status:"
		echo "$out"
		fail=1
	fi
}

caret=$( fixture caret \
	'{ "dependencies": { "@wordpress/element": "^9.8.7" } }' \
	'"node_modules/@wordpress/element": { "version" : "9.8.7" }' )
assert_flags "a caret declaration is flagged" "$caret" "@wordpress/element ^9.8.7"

drift=$( fixture drift \
	'{ "dependencies": { "@wordpress/element": "9.8.7" } }' \
	'"node_modules/@wordpress/element": { "version" : "9.11.0" }' )
assert_flags "a lock above the exact declaration is flagged" "$drift" "9.11.0"

exact=$( fixture exact \
	'{ "dependencies": { "@wordpress/element": "9.8.7", "react": "^18.0.0" } }' \
	'"node_modules/@wordpress/element": { "version" : "9.8.7" }, "node_modules/react": { "version" : "18.3.1" }' )
assert_clean "an exact declaration the lock matches is clean" "$exact"

tooling=$( fixture tooling \
	'{ "devDependencies": { "@wordpress/eslint-plugin": "^24.5.0" } }' \
	'"node_modules/@wordpress/eslint-plugin": { "version" : "24.5.0" }' )
assert_clean "a devDependency caret is tooling and not checked" "$tooling"

none=$( fixture none '{ "name": "no-wp" }' '"node_modules/react": { "version" : "18.3.1" }' )
assert_clean "a package with no @wordpress/* runtime dependency is clean" "$none"

missing=$( fixture missing \
	'{ "dependencies": { "@wordpress/element": "9.8.7" } }' \
	'"node_modules/react": { "version" : "18.3.1" }' )
assert_flags "a declaration absent from the lock is flagged" "$missing" "not in package-lock.json"

exit $fail

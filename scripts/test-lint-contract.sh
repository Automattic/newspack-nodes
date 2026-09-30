#!/usr/bin/env bash
# shellcheck disable=SC2016 # the fixtures are PHP source, written verbatim
#
# test-lint-contract.sh — tests for the contract gate's PHP rules and its walk.
#
# Each case builds a throwaway plugin dir and runs the gate with that dir as
# its cwd, because the gate reads `src/`, `examples/` and `includes/` relative
# to where it runs.

set -u
cd "$( dirname "$0" )" || exit 2
command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH"; exit 2; }
gate="$( pwd )/lint-contract.mjs"

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# fixture NAME RELPATH BODY — one throwaway plugin dir holding one file.
fixture() {
	local dir="$tmp/$1"
	mkdir -p "$dir/$( dirname "$2" )"
	printf '%s\n' "$3" > "$dir/$2"
	echo "$dir"
}

# assert_flags LABEL DIR NEEDLE [ARGS…] — exit 1 and report NEEDLE.
assert_flags() {
	local label="$1" dir="$2" needle="$3" out status
	shift 3
	out="$( cd "$dir" && node "$gate" "$@" 2>&1 )"; status=$?
	if [[ $status -eq 1 && "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 1 mentioning '$needle'; got exit $status:"
		echo "$out"
		fail=1
	fi
}

# assert_clean LABEL DIR [ARGS…] — exit 0.
assert_clean() {
	local label="$1" dir="$2" out status
	shift 2
	out="$( cd "$dir" && node "$gate" "$@" 2>&1 )"; status=$?
	if [[ $status -eq 0 ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 0; got exit $status:"
		echo "$out"
		fail=1
	fi
}

bare='$ok = Capabilities::require( '"'"'tune'"'"' );'
scope='$ok = scope_covers( Capabilities::$session_scope, 3 );'
verb='$ok = Capabilities::require_verb( '"'"'tune'"'"' );'
gate_line='$ok = Capabilities::require( '"'"'tune'"'"' );'

d=$( fixture require includes/class-widget.php "$bare" )
assert_flags "Capabilities::require( is flagged" "$d" "[scope-check-in-handler]"

d=$( fixture qualified includes/class-widget.php '$ok = \Newspack_Nodes\Capabilities::require( '"'"'tune'"'"' );' )
assert_flags "a qualified Capabilities::require( is flagged" "$d" "[scope-check-in-handler]"

d=$( fixture verb includes/class-widget.php "$verb" )
assert_clean "Capabilities::require_verb( is not flagged" "$d"

d=$( fixture owner includes/class-capabilities.php "$gate_line" )
assert_clean "class-capabilities.php may call require(" "$d"

d=$( fixture scope includes/class-widget.php "$scope" )
assert_flags "a verb checking the session scope is still flagged" "$d" "[scope-check-in-handler]"

d=$( fixture release examples/demo/release/class-widget.php "$scope" )
assert_clean "a release/ tree is not walked" "$d"

d=$( fixture tests includes/tests/class-widget.php "$scope" )
assert_clean "a tests/ tree is not walked" "$d"
assert_clean "a tests/ path named directly is not scanned" "$d" includes/tests/class-widget.php

d=$( fixture named includes/class-widget.php "$scope" )
assert_flags "a path named directly is scanned" "$d" "[scope-check-in-handler]" includes/class-widget.php

exit $fail

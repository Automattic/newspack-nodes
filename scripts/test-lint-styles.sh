#!/usr/bin/env bash
#
# test-lint-styles.sh — tests for the style gate.
#
# Each case builds a throwaway plugin dir holding one stylesheet that imports
# the shared styles, because the gate judges `src/` relative to where it runs
# and skips a plugin that consumes none.

set -u
cd "$( dirname "$0" )" || exit 2
command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH"; exit 2; }
gate="$( pwd )/lint-styles.mjs"

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# fixture NAME BODY — one throwaway plugin dir whose src/widget.scss holds BODY.
fixture() {
	local dir="$tmp/$1"
	mkdir -p "$dir/src"
	printf '@use "@newspack-nodes/shared/styles/tokens";\n%s\n' "$2" > "$dir/src/widget.scss"
	echo "$dir"
}

# assert_flags LABEL DIR NEEDLE — exit 1 and report NEEDLE.
assert_flags() {
	local label="$1" dir="$2" needle="$3" out status
	out="$( cd "$dir" && node "$gate" 2>&1 )"; status=$?
	if [[ $status -eq 1 && "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 1 mentioning '$needle'; got exit $status:"
		echo "$out"
		fail=1
	fi
}

# assert_clean LABEL DIR — exit 0.
assert_clean() {
	local label="$1" dir="$2" out status
	out="$( cd "$dir" && node "$gate" 2>&1 )"; status=$?
	if [[ $status -eq 0 ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected exit 0; got exit $status:"
		echo "$out"
		fail=1
	fi
}

repaint='.widget .button {
	color: red;
}'

d=$( fixture repaint "$repaint" )
assert_flags "a component repainting .button is flagged at its line" "$d" "src/widget.scss:2:"

d=$( fixture layout '.widget .button {
	margin: 4px;
}' )
assert_clean "placing a shared control is not flagged" "$d"

d=$( fixture opted '.widget .button {
	color: red; // styles-ok: out-specifies a third party
}' )
assert_clean "a styles-ok on the declaration opts out" "$d"

d=$( fixture below-block "/*
 * A block comment
 * three lines long.
 */
$repaint" )
assert_flags "a block comment keeps the line numbers below it" "$d" "src/widget.scss:6:"

d=$( fixture opted-below-block '/*
 * A block comment
 * three lines long.
 */
.widget .button {
	color: red; // styles-ok: out-specifies a third party
}' )
assert_clean "a styles-ok below a block comment still opts out" "$d"

d=$( fixture unterminated '.widget .button { color: red }' )
assert_flags "a last declaration without its semicolon is still judged" "$d" "(color: red;)"

d=$( fixture unterminated-nested '.widget {
	.button {
		margin: 4px;
		background: #c0ffee
	}
}' )
assert_flags "an unterminated declaration closing a nested block is judged" "$d" "(background: #c0ffee;)"

exit $fail

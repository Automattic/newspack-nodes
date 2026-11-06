#!/usr/bin/env bash
#
# test-coverage-php.sh — tests for scripts/lib/coverage-php.sh, the one place a
# plugin's coverage run chooses its driver.
#
# The lib is sourced by every tests/run-coverage.sh and by pyrobase's pre-push.
# A stub php on PATH stands in for the interpreter, so this needs no extension.

# shellcheck disable=SC2015 # pass()/bad() both return 0, so every `cond && pass || bad` below is a safe two-way branch, not if-then-else.
set -u
cd "$( dirname "$0" )" || exit 2
lib="$( pwd )/lib/coverage-php.sh"
tmp="$( mktemp -d )"
trap 'rm -f "$tmp"/php; rmdir "$tmp"' EXIT
fail=0
pass() { echo "✓ $1"; }
bad()  { echo "✗ $1"; fail=1; }

# stub_php RC — `php --ri pcov` answers RC, as a module present or absent does.
stub_php() {
	printf '#!/bin/sh\nexit %s\n' "$1" > "$tmp/php"
	chmod +x "$tmp/php"
}

# run_lib ROOT — source the lib in a clean shell, then print what it armed.
run_lib() {
	PATH="$tmp:$PATH" XDEBUG_MODE=coverage bash -c '
		. "$1"
		coverage_php "$2"
		echo "mode=$XDEBUG_MODE"
		printf "arg=%s\n" "${COVERAGE_PHP[@]}"
		echo reached
	' _ "$lib" "$1" 2>&1
}

root=/srv/kea-6613/plugin

# (A) a loaded module arms PCOV on this plugin's own tree, with Xdebug off
stub_php 0
out="$( run_lib "$root" )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "arms the run when the module is loaded" || bad "exit $rc: $out"
grep -qxF 'mode=off' <<<"$out" && pass "exports XDEBUG_MODE=off over an inherited coverage" || bad "XDEBUG_MODE not off: $out"
grep -qxF 'arg=php' <<<"$out" && pass "starts with php" || bad "no php: $out"
grep -qxF 'arg=pcov.enabled=1' <<<"$out" && pass "enables PCOV for this run" || bad "PCOV not enabled: $out"
grep -qxF "arg=pcov.directory=$root" <<<"$out" && pass "scopes PCOV to the plugin the caller names" || bad "wrong directory: $out"
grep -qF 'arg=pcov.exclude=' <<<"$out" && grep -qF 'vendor' <<<"$out" && pass "keeps vendor out of the instrumented tree" || bad "no exclude: $out"

# (B) no module fails loud, before any suite runs and before the caller goes on
stub_php 1
out="$( run_lib "$root" )"; rc=$?
[[ "$rc" -ne 0 ]] && pass "exits non-zero when the module is missing" || bad "a missing module passed: $out"
grep -q 'php8.4-pcov' <<<"$out" && pass "names the package" || bad "no package named: $out"
grep -qxF 'reached' <<<"$out" && bad "the caller went on after the refusal" || pass "stops the caller"

# (C) no root is a caller's bug, refused rather than scoped to everything
stub_php 0
out="$( run_lib "" )"; rc=$?
[[ "$rc" -ne 0 ]] && pass "refuses an empty plugin root" || bad "an empty root passed: $out"

exit "$fail"

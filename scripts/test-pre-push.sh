#!/usr/bin/env bash
#
# Tests for scripts/pre-push, the shared hook, and this plugin's
# pre-push.local. Each case runs the hook in a throwaway repository with npm
# and docker stubbed, so no case reaches a container or the network.

# shellcheck disable=SC2015 # pass()/bad() both return 0, so every `cond && pass || bad` below is a safe two-way branch, not if-then-else.
set -u
here="$( cd "$( dirname "$0" )" && pwd )"
tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0
pass() { echo "✓ $1"; }
bad()  { echo "✗ $1"; fail=1; }

# (A) push_gates runs every self-test this directory carries, each once.
gated="$(
	# shellcheck disable=SC2329 # invoked by the sourced push_gates
	script_gate() { echo "$1"; }
	# shellcheck disable=SC2034 # pre-push.local reads it
	HOST=stub-host
	# shellcheck source-path=SCRIPTDIR source=pre-push.local
	. "$here/pre-push.local"
	push_gates
)"
present="$( cd "$here" && ls test-*.sh )"
[[ "$( sort <<<"$gated" )" == "$( sort <<<"$present" )" ]] \
	&& pass "push_gates runs every scripts/test-*.sh" \
	|| bad "push_gates and scripts/test-*.sh differ: $( diff <( sort <<<"$gated" ) <( sort <<<"$present" ) | tr '\n' ' ' )"
[[ "$( sort <<<"$gated" | uniq -d )" == "" ]] && pass "no self-test runs twice" || bad "a self-test runs twice"

# A repository carrying the hook and a stub .local naming no real container.
repo="$tmp/repo"
mkdir -p "$repo/scripts" "$tmp/bin"
cp "$here/pre-push" "$repo/scripts/pre-push"
cat > "$repo/scripts/pre-push.local" <<'LOCAL'
# shellcheck shell=bash
push_gates() { :; }
container_gates() { :; }
# shellcheck disable=SC2034
{
	readonly PLUGIN_SLUG="stub-plugin-4417"
	readonly CONTAINER="no-such-container-4417"
	readonly DEPLOY_CONTAINER="$CONTAINER"
	readonly DEPLOY_SCRIPT="/nowhere/deploy.sh"
	readonly TEST_DIR_IN_CONTAINER="/nowhere/tests"
	readonly COVERAGE_DIR="stub-plugin-4417-coverage"
}
LOCAL
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/npm"
# `docker ps` lists whatever STUB_CONTAINERS names, then STUB_FILLER more
# lines; its status is the listing's, as a real docker killed by SIGPIPE
# reports. Every other call succeeds.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
[ "$1" = ps ] || exit 0
printf '%s\n' "${STUB_CONTAINERS:-}"
[ "${STUB_FILLER:-0}" -gt 0 ] || exit 0
yes stub-container-filler | head -n "$STUB_FILLER"
STUB
chmod +x "$tmp/bin/npm" "$tmp/bin/docker"
echo '{}' > "$repo/package.json"
git -C "$repo" init -q -b main
git -C "$repo" -c user.email=t@example.com -c user.name=t add -A
git -C "$repo" -c user.email=t@example.com -c user.name=t commit -qm base
base="$( git -C "$repo" rev-parse HEAD )"
git -C "$repo" worktree add -q -b side "$tmp/worktree" 2>/dev/null

# Commit one PHP file in $1 and push it through the hook from there; $2, when
# given, names a container `docker ps` lists, and $3 how many lines follow it.
push_php_from() {
	local dir="$1" running="${2:-}"
	echo "<?php // $RANDOM" > "$dir/class-x.php"
	git -C "$dir" -c user.email=t@example.com -c user.name=t add class-x.php
	git -C "$dir" -c user.email=t@example.com -c user.name=t commit -qm php
	local sha
	sha="$( git -C "$dir" rev-parse HEAD )"
	( cd "$dir" && STUB_CONTAINERS="$running" STUB_FILLER="${3:-0}" PATH="$tmp/bin:$PATH" bash scripts/pre-push origin url \
		<<<"refs/heads/x $sha refs/heads/x $base" 2>&1 )
}

# (B) a PHP push from the main checkout reaches the container section.
out="$( push_php_from "$repo" )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "a main-checkout PHP push passes" || bad "main-checkout push failed: $out"
grep -q 'not available' <<<"$out" && pass "and reaches the container gates" || bad "never reached the container gates: $out"

refusal='mounts the main checkout'

# (C) with the container running, a worktree PHP push refuses before any gate.
out="$( push_php_from "$tmp/worktree" no-such-container-4417 )"; rc=$?
[[ "$rc" -ne 0 ]] && pass "a worktree PHP push with the container up fails" || bad "a worktree PHP push passed: $out"
grep -q "$refusal" <<<"$out" && pass "with the worktree refusal" || bad "no worktree refusal: $out"
grep -q 'test:js' <<<"$out" && bad "the refusal came after the JS tests" || pass "before the JS tests run"

# (D) with no container, a worktree PHP push skips the container gates as any push does.
out="$( push_php_from "$tmp/worktree" )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "a worktree PHP push with no container passes" || bad "a worktree push with no container failed: $out"
grep -q 'not available' <<<"$out" && pass "and skips the container gates" || bad "never reached the skip: $out"
grep -q "$refusal" <<<"$out" && bad "refused with no container gate to run" || pass "without the worktree refusal"

# (E) a long `docker ps` listing still reads the container as up.
out="$( push_php_from "$tmp/worktree" no-such-container-4417 200000 )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -q "$refusal" <<<"$out" \
	&& pass "a container listed ahead of 200000 more lines still refuses the worktree push" \
	|| bad "a long listing read the container as down: $out"

exit "$fail"

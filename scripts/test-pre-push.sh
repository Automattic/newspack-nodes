#!/usr/bin/env bash
#
# Tests for scripts/pre-push, the shared hook, and this plugin's
# pre-push.local. Each case runs the hook in a throwaway repository with npm,
# node, python3 and docker stubbed, so no case reaches a container or the
# network. The hook-driven cases run again under /bin/bash when that is
# another bash than PATH's, as macOS's 3.2 is.

# shellcheck disable=SC2015 # pass()/bad() both return 0, so every `cond && pass || bad` below is a safe two-way branch, not if-then-else.
set -u
here="$( cd "$( dirname "$0" )" && pwd )"
hook_bash="${HOOK_BASH:-bash}"
# Unique per run, because the hook writes /tmp/<slug>-pre-push-*.out.
slug="stub-plugin-$$"
tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"; rm -f "/tmp/${slug}-pre-push-build.out" "/tmp/${slug}-pre-push-coverage.out"' EXIT
fail=0
pass() { echo "✓ $1"; }
bad()  { echo "✗ $1"; fail=1; }

# The static checks run once, under the bash that started the file.
if [[ -z "${HOOK_BASH:-}" ]]; then
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

	# (L) deferrable, the deferred() calls and AGENTS.md name the same gates.
	# shellcheck disable=SC2154 # the eval'd line from pre-push assigns deferrable
	declared="$( eval "$( grep -E '^readonly -a deferrable=' "$here/pre-push" )"; printf '%s\n' ${deferrable[@]+"${deferrable[@]}"} | sort )"
	called="$( grep -vE '^[[:space:]]*#' "$here/pre-push" | grep -v 'deferred by pre-push.local' \
		| grep -oE '(^|[^a-z_])deferred [a-z][a-z:-]*' | sed 's/.*deferred //' | sort )"
	# shellcheck disable=SC2016 # the backticks are AGENTS.md's, not a command
	documented="$( grep -oE "the hook's \`deferrable\` list: [^.]*\." "$here/../AGENTS.md" \
		| sed 's/^[^:]*: //' | grep -oE '`[^`]+`' | tr -d '`' | sort )"
	[[ -n "$declared" && "$( uniq -d <<<"$declared" )" == "" ]] \
		&& pass "deferrable names each gate once" || bad "deferrable is missing or repeats a gate: $( tr '\n' ' ' <<<"$declared" )"
	[[ "$declared" == "$called" ]] \
		&& pass "each deferrable gate has one deferred() call, and every call names one" \
		|| bad "deferrable and the deferred() calls differ: $( diff <( echo "$declared" ) <( echo "$called" ) | tr '\n' ' ' )"
	[[ "$declared" == "$documented" ]] \
		&& pass "AGENTS.md lists the deferrable gates" \
		|| bad "deferrable and AGENTS.md's list differ: $( diff <( echo "$declared" ) <( echo "$documented" ) | tr '\n' ' ' )"
fi

# A repository carrying the hook and a stub .local naming no real container.
# It sits four levels below $tmp, which the hook therefore reads as dndocker.
repo="$tmp/dn/a/b/repo"
mkdir -p "$repo/scripts" "$tmp/bin"
cp "$here/pre-push" "$repo/scripts/pre-push"
# The gates' own scripts, present so each gate is in scope; the stubs run them.
touch "$repo/scripts/coverage-gate-js.mjs" "$repo/scripts/lint-wp-pin.mjs" "$repo/scripts/coverage-gate.py"
# Writes the stub .local, with $1 appended when given.
write_local() {
	cat > "$repo/scripts/pre-push.local" <<LOCAL
# shellcheck shell=bash
push_gates() { :; }
container_gates() { :; }
# shellcheck disable=SC2034
{
	readonly PLUGIN_SLUG="${slug}"
	readonly CONTAINER="no-such-container-4417"
	readonly DEPLOY_CONTAINER="\$CONTAINER"
	readonly DEPLOY_SCRIPT="/nowhere/deploy.sh"
	readonly TEST_DIR_IN_CONTAINER="/nowhere/tests"
	readonly COVERAGE_DIR="${slug}-coverage"
}
LOCAL
	printf '%s\n' "${1:-}" >> "$repo/scripts/pre-push.local"
}
write_local
# npm, node and python3 log each call as one line and succeed.
calls="$tmp/calls.log"
for tool in npm node python3; do
	printf '#!/bin/sh\nprintf "%%s %%s\\n" %s "$*" >> "%s"\n' "$tool" "$calls" > "$tmp/bin/$tool"
done
# `docker ps` lists whatever STUB_CONTAINERS names, then STUB_FILLER more
# lines and exits with the listing's status, as a real docker killed by
# SIGPIPE reports. Every other call succeeds.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
[ "$1" = ps ] || exit 0
printf '%s\n' "${STUB_CONTAINERS:-}"
[ "${STUB_FILLER:-0}" -gt 0 ] || exit 0
yes stub-container-filler | head -n "$STUB_FILLER"
STUB
chmod +x "$tmp/bin/npm" "$tmp/bin/node" "$tmp/bin/python3" "$tmp/bin/docker"
# Declares lint:types and a @wordpress/* dependency, so both gates apply.
package_json='{"scripts":{"lint:types":"tsc"},"devDependencies":{"@wordpress/stub":"1.0.0"}}'
echo "$package_json" > "$repo/package.json"
# The clover the per-class gate reads, under the hook's dndocker root.
clover="$tmp/volumes/pyrobase/tmp/${slug}-coverage/clover.xml"
mkdir -p "$( dirname "$clover" )"
echo '<coverage/>' > "$clover"
git -C "$repo" init -q -b main
git -C "$repo" -c user.email=t@example.com -c user.name=t add -A
git -C "$repo" -c user.email=t@example.com -c user.name=t commit -qm base
base="$( git -C "$repo" rev-parse HEAD )"
git -C "$repo" worktree add -q -b side "$tmp/worktree" 2>/dev/null

# Pushes HEAD of $1 through the hook from there, with an empty call log; $2,
# when given, names a container `docker ps` lists, $3 how many lines follow,
# and $4 the remote's commit, the base commit by default.
push_head_from() {
	local dir="$1" running="${2:-}" sha
	sha="$( git -C "$dir" rev-parse HEAD )"
	: > "$calls"
	( cd "$dir" && STUB_CONTAINERS="$running" STUB_FILLER="${3:-0}" PATH="$tmp/bin:$PATH" "$hook_bash" scripts/pre-push origin url \
		<<<"refs/heads/x $sha refs/heads/x ${4:-$base}" 2>&1 )
}

# Commits each named file in $1, its content the HEAD it changes from.
commit_in() {
	local dir="$1" file head
	shift
	head="$( git -C "$dir" rev-parse HEAD )"
	for file in "$@"; do
		echo "// ${head}" > "$dir/$file"
		git -C "$dir" add "$file"
	done
	git -C "$dir" -c user.email=t@example.com -c user.name=t commit -qm change
}

# Commit one PHP file in $1 and push it from there; $2 and $3 as above.
push_php_from() {
	commit_in "$1" class-x.php
	push_head_from "$@"
}

# Commits the named files in the main checkout and pushes that one commit,
# with the container up unless STUB_DOWN is set.
push() {
	local from
	from="$( git -C "$repo" rev-parse HEAD )"
	commit_in "$repo" "$@"
	push_head_from "$repo" "${STUB_DOWN:-no-such-container-4417}" 0 "$from"
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

# Each deferrable gate, then the call its running leaves in the log.
GATES=(
	js-coverage-gate 'node .*/coverage-gate-js\.mjs'
	wp-pin 'node .*/lint-wp-pin\.mjs'
	lint:php 'npm run lint:php'
	lint:js 'npm run lint:js'
	lint:types 'npm run lint:types'
	lint:scss 'npm run lint:scss'
	coverage-gate 'python3 .*/coverage-gate\.py'
)
every_kind=( class-x.php x.js x.ts x.scss )

# Every gate but $1 left its call in the log; "" names none.
others_ran() {
	local i missing=""
	for (( i = 0; i < ${#GATES[@]}; i += 2 )); do
		[[ "${GATES[i]}" == "$1" ]] && continue
		grep -qE "${GATES[i + 1]}" "$calls" || missing+=" ${GATES[i]}"
	done
	[[ -z "$missing" ]] && pass "every other gate runs" || bad "these gates never ran:${missing}"
}

# The push in $out passed and printed no deferral line; $1 names the case.
none_deferred() {
	[[ "$rc" -eq 0 ]] && ! grep -q 'deferred by' <<<"$out" \
		&& pass "$1 prints no deferral" || bad "$1 printed a deferral or failed: $out"
}

# (F) each deferred gate prints its one line and never runs; the rest run.
for (( i = 0; i < ${#GATES[@]}; i += 2 )); do
	gate="${GATES[i]}"
	write_local "DEFERRED_GATES=( ${gate} )"
	out="$( push "${every_kind[@]}" )"; rc=$?
	[[ "$rc" -eq 0 ]] && pass "a push deferring ${gate} passes" || bad "a push deferring ${gate} failed: $out"
	[[ "$( grep -c "${gate} deferred by pre-push.local" <<<"$out" )" -eq 1 ]] \
		&& pass "and prints the ${gate} deferral line once" || bad "no single ${gate} deferral line: $out"
	grep -qE "${GATES[i + 1]}" "$calls" && bad "yet ${gate} ran" || pass "and never runs ${gate}"
	others_ran "$gate"
done

# (G) a name no gate answers to fails the push before any gate runs.
write_local 'DEFERRED_GATES=( lint:phpp )'
out="$( push class-x.php )"; rc=$?
[[ "$rc" -ne 0 ]] && pass "a push deferring lint:phpp fails" || bad "a push deferring lint:phpp passed: $out"
grep -q 'pre-push.local defers unknown gate lint:phpp' <<<"$out" \
	&& pass "with the unknown-gate message" || bad "no unknown-gate message: $out"
[[ -s "$calls" ]] && bad "after a gate ran: $( tr '\n' ' ' < "$calls" )" || pass "before any gate runs"

# (H) a .local naming no list runs every gate.
write_local
out="$( push "${every_kind[@]}" )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "a push with no list passes" || bad "a push with no list failed: $out"
others_ran ''
none_deferred "a push with no list"

# (I) the environment cannot defer a gate; only the .local can.
export DEFERRED_GATES=lint:php
out="$( push class-x.php )"; rc=$?
unset DEFERRED_GATES
grep -qE 'npm run lint:php' "$calls" && pass "an exported DEFERRED_GATES leaves lint:php running" \
	|| bad "the environment deferred lint:php: $out"
none_deferred "a push under an exported DEFERRED_GATES"

# (J) an empty list in the .local runs every gate.
write_local 'DEFERRED_GATES=()'
out="$( push "${every_kind[@]}" )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "a push with an empty list passes" || bad "a push with an empty list failed: $out"
others_ran ''
none_deferred "a push with an empty list"

# (K) a deferral line prints only where its gate would otherwise have run.
write_local 'DEFERRED_GATES=( lint:php )'
out="$( push x.js )"; rc=$?
none_deferred "a JS-only push deferring lint:php"
write_local 'DEFERRED_GATES=( lint:js lint:types lint:scss )'
out="$( push class-x.php )"; rc=$?
none_deferred "a PHP-only push deferring lint:js, lint:types and lint:scss"
write_local 'DEFERRED_GATES=( lint:types )'
echo '{}' > "$repo/package.json"
out="$( push x.ts )"; rc=$?
echo "$package_json" > "$repo/package.json"
none_deferred "a TS push deferring lint:types where the plugin declares none"
grep -q 'declares no lint:types' <<<"$out" && pass "which says it skips lint:types" || bad "no lint:types skip line: $out"
write_local 'DEFERRED_GATES=( wp-pin )'
echo '{"scripts":{"lint:types":"tsc"}}' > "$repo/package.json"
out="$( push README.md )"; rc=$?
echo "$package_json" > "$repo/package.json"
none_deferred "a push deferring wp-pin with no @wordpress/* dependency"
write_local 'DEFERRED_GATES=( js-coverage-gate )'
mv "$repo/scripts/coverage-gate-js.mjs" "$tmp/coverage-gate-js.mjs"
out="$( push README.md )"; rc=$?
mv "$tmp/coverage-gate-js.mjs" "$repo/scripts/coverage-gate-js.mjs"
none_deferred "a push deferring js-coverage-gate with no coverage-gate-js.mjs"
write_local 'DEFERRED_GATES=( coverage-gate )'
mv "$clover" "$clover.away"
out="$( push class-x.php )"; rc=$?
mv "$clover.away" "$clover"
none_deferred "a PHP push deferring coverage-gate with no clover"
grep -q 'coverage gate skipped' <<<"$out" && pass "which says it skips the coverage gate" || bad "no coverage gate skip line: $out"
out="$( STUB_DOWN=' ' push class-x.php )"; rc=$?
none_deferred "a PHP push deferring coverage-gate with the container down"

# (M) a deferred() call naming a gate deferrable lacks fails loud, naming it.
sed 's/deferred lint:js;/deferred lint:jss;/' "$here/pre-push" > "$repo/scripts/pre-push"
write_local
out="$( push x.js )"; rc=$?
cp "$here/pre-push" "$repo/scripts/pre-push"
[[ "$rc" -ne 0 ]] && grep -q 'lint:jss' <<<"$out" \
	&& pass "deferred() asked about an undeclared gate fails, naming it" \
	|| bad "deferred lint:jss did not fail loud: $out"

# (N) a gate slot cannot add a name the validation never saw.
write_local 'container_gates() { DEFERRED_GATES+=( coverage-gate ); }'
out="$( push class-x.php )"; rc=$?
write_local
[[ "$rc" -ne 0 ]] && pass "container_gates appending to DEFERRED_GATES fails the push" \
	|| bad "container_gates appended to DEFERRED_GATES unchecked: $out"
grep -q 'readonly' <<<"$out" && pass "naming the read-only list" || bad "no read-only failure: $out"
grep -q 'deferred by' <<<"$out" && bad "and deferred coverage-gate: $out" || pass "rather than deferring coverage-gate"

# The hook-driven cases once more under /bin/bash, when that differs.
if [[ -z "${HOOK_BASH:-}" && -x /bin/bash ]]; then
	other="$( /bin/bash -c 'echo "$BASH_VERSION"' )"
	if [[ "$other" != "$( bash -c 'echo "$BASH_VERSION"' )" ]]; then
		echo "— the hook-driven cases again under /bin/bash ${other}"
		HOOK_BASH=/bin/bash /bin/bash "$0" || fail=1
	fi
fi

exit "$fail"

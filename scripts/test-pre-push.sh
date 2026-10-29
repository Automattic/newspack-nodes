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
slug="stub-plugin-$$"
tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
# The hook's TMPDIR, so every log it captures lands inside $tmp.
logs="$tmp/logs"
mkdir -p "$logs"
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

	# (L) deferrable, the run_gate calls and AGENTS.md name the same gates.
	# shellcheck disable=SC2154 # the eval'd line from pre-push assigns deferrable
	declared="$( eval "$( grep -E '^readonly -a deferrable=' "$here/pre-push" )"; printf '%s\n' ${deferrable[@]+"${deferrable[@]}"} | sort )"
	called="$( grep -vE '^[[:space:]]*#' "$here/pre-push" \
		| grep -oE '(^|[^a-z_])run_gate [a-z][a-z:-]*' | sed 's/.*run_gate //' | sort )"
	# shellcheck disable=SC2016 # the backticks are AGENTS.md's, not a command
	documented="$( grep -oE "the hook's \`deferrable\` list: [^.]*\." "$here/../AGENTS.md" \
		| sed 's/^[^:]*: //' | grep -oE '`[^`]+`' | tr -d '`' | sort )"
	[[ -n "$declared" && "$( uniq -d <<<"$declared" )" == "" ]] \
		&& pass "deferrable names each gate once" || bad "deferrable is missing or repeats a gate: $( tr '\n' ' ' <<<"$declared" )"
	[[ "$declared" == "$called" ]] \
		&& pass "each deferrable gate has one run_gate call, and every call names one" \
		|| bad "deferrable and the run_gate calls differ: $( diff <( echo "$declared" ) <( echo "$called" ) | tr '\n' ' ' )"
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
# Every stub fails a call STUB_FAILING matches: it prints STUB_LINES numbered
# lines, three by default, the last without its newline when STUB_NO_EOL is
# set, and exits STUB_STATUS, 1 by default. Any other call succeeds.
# shellcheck disable=SC2016 # expanded by the stub, not here
stub_failure='if [ -n "${STUB_FAILING:-}" ] && printf "%s\n" "$line" | grep -qE "$STUB_FAILING"; then
	i=1
	while [ "$i" -lt "${STUB_LINES:-3}" ]; do echo "stub failure line $i"; i=$((i + 1)); done
	if [ -n "${STUB_NO_EOL:-}" ]; then printf "stub failure line %s" "$i"; else echo "stub failure line $i"; fi
	exit "${STUB_STATUS:-1}"
fi'
# npm, node and python3 also log each call as one line.
calls="$tmp/calls.log"
for tool in npm node python3; do
	{
		echo '#!/bin/sh'
		echo "line=\"$tool \$*\""
		printf '%s\n' "printf '%s\\n' \"\$line\" >> \"$calls\""
		echo "$stub_failure"
	} > "$tmp/bin/$tool"
done
# `docker ps` lists whatever STUB_CONTAINERS names, then STUB_FILLER more
# lines and exits with the listing's status, as a real docker killed by
# SIGPIPE reports.
{
	cat <<'STUB'
#!/bin/sh
if [ "$1" = ps ]; then
	printf '%s\n' "${STUB_CONTAINERS:-}"
	[ "${STUB_FILLER:-0}" -gt 0 ] || exit 0
	yes stub-container-filler | head -n "$STUB_FILLER"
	exit
fi
line="docker $*"
STUB
	echo "$stub_failure"
} > "$tmp/bin/docker"
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
# and $4 the remote's commit, the base commit by default. The STUB_ settings
# reach the stubs, and HOOK_TMPDIR, $logs by default, is the hook's TMPDIR.
push_head_from() {
	local dir="$1" running="${2:-}" sha
	sha="$( git -C "$dir" rev-parse HEAD )"
	: > "$calls"
	( cd "$dir" && STUB_FAILING="${STUB_FAILING:-}" STUB_LINES="${STUB_LINES:-3}" STUB_STATUS="${STUB_STATUS:-1}" \
		STUB_NO_EOL="${STUB_NO_EOL:-}" TMPDIR="${HOOK_TMPDIR:-$logs}" \
		STUB_CONTAINERS="$running" STUB_FILLER="${3:-0}" PATH="$tmp/bin:$PATH" "$hook_bash" scripts/pre-push origin url \
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

# Each deferrable gate, the call its running leaves in the log, and the
# message its failure fails the push with.
GATES=(
	js-coverage-gate 'node .*/coverage-gate-js\.mjs' 'JS coverage gate failed'
	wp-pin 'node .*/lint-wp-pin\.mjs' 'lint-wp-pin failed'
	lint:php 'npm run lint:php' 'lint:php failed'
	lint:js 'npm run lint:js' 'lint:js failed'
	lint:types 'npm run lint:types' 'lint:types failed'
	lint:scss 'npm run lint:scss' 'lint:scss failed'
	coverage-gate 'python3 .*/coverage-gate\.py' 'coverage gate failed'
)
every_kind=( class-x.php x.js x.ts x.scss )

# Every gate but $1 left its call in the log; "" names none.
others_ran() {
	local i missing=""
	for (( i = 0; i < ${#GATES[@]}; i += 3 )); do
		[[ "${GATES[i]}" == "$1" ]] && continue
		grep -qE "${GATES[i + 1]}" "$calls" || missing+=" ${GATES[i]}"
	done
	[[ -z "$missing" ]] && pass "every other gate runs" || bad "these gates never ran:${missing}"
}

# The push in $out passed with no deferral line and never ran the gate whose
# call matches $1; $2 names the case.
not_run() {
	[[ "$rc" -eq 0 ]] && ! grep -q 'deferred by' <<<"$out" && ! grep -qE "$1" "$calls" \
		&& pass "$2 never runs the gate" || bad "$2 ran the gate, deferred it or failed: $out"
}

# (F) each gate, deferred and failing, deferred and passing, then enforced.
for (( i = 0; i < ${#GATES[@]}; i += 3 )); do
	gate="${GATES[i]}"
	write_local "DEFERRED_GATES=( ${gate} )"
	out="$( STUB_FAILING="${GATES[i + 1]}" push "${every_kind[@]}" )"; rc=$?
	[[ "$rc" -eq 0 ]] && pass "a push deferring a failing ${gate} passes" || bad "a push deferring a failing ${gate} failed: $out"
	[[ "$( grep -c "${gate} deferred by pre-push.local: still failing" <<<"$out" )" -eq 1 ]] \
		&& pass "and prints the ${gate} still-failing line once" || bad "no single ${gate} still-failing line: $out"
	grep -qx 'stub failure line 3' <<<"$out" && pass "after the gate's own output" || bad "the ${gate} output is hidden: $out"
	others_ran "$gate"
	out="$( push "${every_kind[@]}" )"; rc=$?
	[[ "$rc" -ne 0 ]] && grep -q "${gate} passes; remove it from DEFERRED_GATES in pre-push.local" <<<"$out" \
		&& pass "a push deferring a passing ${gate} fails, asking to remove it" \
		|| bad "a deferred ${gate} that passes did not fail the push: $out"
	write_local
	out="$( STUB_FAILING="${GATES[i + 1]}" push "${every_kind[@]}" )"; rc=$?
	[[ "$rc" -ne 0 ]] && ! grep -q 'deferred by' <<<"$out" \
		&& pass "an enforced ${gate} that fails still fails the push" \
		|| bad "an enforced ${gate} failure did not fail the push: $out"
	grep -qx 'stub failure line 3' <<<"$out" && grep -q "${GATES[i + 2]}" <<<"$out" \
		&& pass "showing the gate's output and its failure message" \
		|| bad "the enforced ${gate} failure hid its output or message: $out"
done

# (F2) a deferred gate printing many lines shows its last 40 and where the rest are.
write_local 'DEFERRED_GATES=( lint:php )'
out="$( STUB_FAILING='npm run lint:php' STUB_LINES=100 push class-x.php )"; rc=$?
[[ "$rc" -eq 0 ]] && grep -qx 'stub failure line 100' <<<"$out" && grep -qx 'stub failure line 61' <<<"$out" \
	&& ! grep -qx 'stub failure line 60' <<<"$out" \
	&& pass "a long deferred failure shows its last 40 lines" || bad "the long failure was not cut to its last 40 lines: $out"
held="$( grep -oE "60 earlier lines in ${logs}/${slug}-pre-push-lint-php\.[A-Za-z0-9]{6}([^A-Za-z0-9]|$)" <<<"$out" | sed 's/.* in //; s/[^A-Za-z0-9]$//' )"
[[ -n "$held" ]] && pass "and names the mktemp file holding the rest" || bad "no pointer to a mktemp log: $out"
[[ -f "$held" && "$( awk 'END { print NR }' "$held" )" -eq 100 ]] \
	&& pass "which holds every line" || bad "the named log does not hold 100 lines"

# (F3) output with no final newline is counted whole and ends its own line.
out="$( STUB_FAILING='npm run lint:php' STUB_LINES=45 STUB_NO_EOL=1 push class-x.php )"; rc=$?
grep -q '… 5 earlier lines in' <<<"$out" && pass "an unterminated last line still counts" \
	|| bad "the unterminated last line was miscounted: $out"
again="$( grep -oE "in ${logs}/${slug}-pre-push-lint-php\.[A-Za-z0-9]{6}([^A-Za-z0-9]|$)" <<<"$out" | sed 's/^in //; s/[^A-Za-z0-9]$//' )"
[[ -n "$again" && "$again" != "$held" && "$( awk 'END { print NR }' "$held" )" -eq 100 ]] \
	&& pass "in a fresh log, leaving the earlier one whole" || bad "the second failure reused a log: ${held} ${again}"
grep -qx 'stub failure line 45' <<<"$out" && grep -q 'lint:php deferred by pre-push.local: still failing' <<<"$out" \
	&& pass "and the hook's next line starts on its own line" || bad "the next hook line ran on: $out"

# (F4) a deferred gate that cannot run fails the push, naming gate and status.
out="$( STUB_FAILING='npm run lint:php' STUB_STATUS=127 push class-x.php )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -q 'lint:php could not run (exit 127)' <<<"$out" && ! grep -q 'still failing' <<<"$out" \
	&& pass "a deferred gate exiting 127 fails the push as unable to run" \
	|| bad "a deferred gate exiting 127 read as still failing: $out"
out="$( STUB_FAILING='npm run lint:php' STUB_STATUS=130 push class-x.php )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -q 'lint:php could not run (exit 130)' <<<"$out" \
	&& pass "and so does one killed by a signal" || bad "a deferred gate exiting 130 read as still failing: $out"
out="$( STUB_FAILING='npm run lint:php' HOOK_TMPDIR="$tmp/no-such-dir" push class-x.php )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -q "lint:php: cannot create a log under ${tmp}/no-such-dir" <<<"$out" \
	&& ! grep -q 'still failing' <<<"$out" \
	&& pass "a deferred gate whose log cannot be written fails the push" \
	|| bad "an unwritable log did not fail the push: $out"

# (F5) the build and the coverage suite capture through the same helper.
write_local
out="$( STUB_FAILING='npm run build' push x.js )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -qx 'stub failure line 3' <<<"$out" \
	&& grep -qE "npm run build failed — full output at ${logs}/${slug}-pre-push-npm-run-build\.[A-Za-z0-9]+" <<<"$out" \
	&& pass "a failing build shows its tail and names its mktemp log" || bad "the build failure lost its tail or log: $out"
out="$( STUB_FAILING='run-coverage' STUB_LINES=5 push class-x.php )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -qx 'stub failure line 3' <<<"$out" && ! grep -qx 'stub failure line 2' <<<"$out" \
	&& grep -qE "coverage suite failed \(exit 1\) — full output at ${logs}/${slug}-pre-push-coverage-suite\.[A-Za-z0-9]+" <<<"$out" \
	&& pass "a failing coverage suite shows its last 3 lines and names its mktemp log" \
	|| bad "the coverage failure lost its tail or log: $out"

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
[[ "$rc" -eq 0 ]] && ! grep -q 'deferred by' <<<"$out" \
	&& pass "a push with no list passes, deferring nothing" || bad "a push with no list failed or deferred: $out"
others_ran ''

# (I) the environment cannot defer a gate; only the .local can.
export DEFERRED_GATES=lint:php
out="$( push class-x.php )"; rc=$?
unset DEFERRED_GATES
[[ "$rc" -eq 0 ]] && grep -qE 'npm run lint:php' "$calls" && ! grep -q 'deferred by\|remove it' <<<"$out" \
	&& pass "an exported DEFERRED_GATES leaves lint:php enforced" \
	|| bad "the environment deferred lint:php: $out"

# (J) an empty list in the .local runs every gate.
write_local 'DEFERRED_GATES=()'
out="$( push "${every_kind[@]}" )"; rc=$?
[[ "$rc" -eq 0 ]] && ! grep -q 'deferred by' <<<"$out" \
	&& pass "a push with an empty list passes, deferring nothing" || bad "a push with an empty list failed or deferred: $out"
others_ran ''

# (K) a deferred gate runs only where it would have run; each gate passes, so
# running it anywhere else fails the push with the remove-it message.
write_local 'DEFERRED_GATES=( lint:php )'
out="$( push x.js )"; rc=$?
not_run 'npm run lint:php' "a JS-only push deferring lint:php"
write_local 'DEFERRED_GATES=( lint:js lint:types lint:scss )'
out="$( push class-x.php )"; rc=$?
not_run 'npm run lint:(js|types|scss)' "a PHP-only push deferring lint:js, lint:types and lint:scss"
write_local 'DEFERRED_GATES=( lint:types )'
echo '{}' > "$repo/package.json"
out="$( push x.ts )"; rc=$?
echo "$package_json" > "$repo/package.json"
not_run 'npm run lint:types' "a TS push deferring lint:types where the plugin declares none"
grep -q 'declares no lint:types' <<<"$out" && pass "which says it skips lint:types" || bad "no lint:types skip line: $out"
write_local 'DEFERRED_GATES=( wp-pin )'
echo '{"scripts":{"lint:types":"tsc"}}' > "$repo/package.json"
out="$( push README.md )"; rc=$?
echo "$package_json" > "$repo/package.json"
not_run 'lint-wp-pin' "a push deferring wp-pin with no @wordpress/* dependency"
write_local 'DEFERRED_GATES=( js-coverage-gate )'
mv "$repo/scripts/coverage-gate-js.mjs" "$tmp/coverage-gate-js.mjs"
out="$( push README.md )"; rc=$?
mv "$tmp/coverage-gate-js.mjs" "$repo/scripts/coverage-gate-js.mjs"
not_run 'coverage-gate-js' "a push deferring js-coverage-gate with no coverage-gate-js.mjs"
write_local 'DEFERRED_GATES=( coverage-gate )'
mv "$clover" "$clover.away"
out="$( push class-x.php )"; rc=$?
mv "$clover.away" "$clover"
not_run 'coverage-gate\.py' "a PHP push deferring coverage-gate with no clover"
grep -q 'coverage gate skipped' <<<"$out" && pass "which says it skips the coverage gate" || bad "no coverage gate skip line: $out"
out="$( STUB_DOWN=' ' push class-x.php )"; rc=$?
not_run 'coverage-gate\.py' "a PHP push deferring coverage-gate with the container down"

# (M) a run_gate call naming a gate deferrable lacks fails loud, naming it.
sed 's/run_gate lint:js /run_gate lint:jss /' "$here/pre-push" > "$repo/scripts/pre-push"
write_local
out="$( push x.js )"; rc=$?
cp "$here/pre-push" "$repo/scripts/pre-push"
[[ "$rc" -ne 0 ]] && grep -q 'lint:jss' <<<"$out" \
	&& pass "run_gate asked to run an undeclared gate fails, naming it" \
	|| bad "run_gate lint:jss did not fail loud: $out"

# (N) a gate slot cannot add a name the validation never saw.
write_local 'container_gates() { DEFERRED_GATES+=( coverage-gate ); }'
out="$( push class-x.php )"; rc=$?
write_local
[[ "$rc" -ne 0 ]] && pass "container_gates appending to DEFERRED_GATES fails the push" \
	|| bad "container_gates appended to DEFERRED_GATES unchecked: $out"
grep -q 'readonly' <<<"$out" && pass "naming the read-only list" || bad "no read-only failure: $out"
grep -q 'deferred by' <<<"$out" && bad "and deferred coverage-gate: $out" || pass "rather than deferring coverage-gate"

# (O) a push changing only the lockfile still lints and builds the frontend.
out="$( STUB_FAILING='npm run build' push package-lock.json )"; rc=$?
[[ "$rc" -ne 0 ]] && grep -q 'npm run build failed' <<<"$out" \
	&& pass "a lockfile-only push runs the build" \
	|| bad "a lockfile-only push skipped the build: $out"
grep -q 'lint:js (1 file(s) changed)' <<<"$out" \
	&& pass "and lint:js" || bad "a lockfile-only push skipped lint:js: $out"

# The hook-driven cases once more under /bin/bash, when that differs.
if [[ -z "${HOOK_BASH:-}" && -x /bin/bash ]]; then
	other="$( /bin/bash -c 'echo "$BASH_VERSION"' )"
	if [[ "$other" != "$( bash -c 'echo "$BASH_VERSION"' )" ]]; then
		echo "— the hook-driven cases again under /bin/bash ${other}"
		HOOK_BASH=/bin/bash /bin/bash "$0" || fail=1
	fi
fi

exit "$fail"

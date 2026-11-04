#!/usr/bin/env bash
#
# Tests for scripts/lint-private-data.py, the gate that keeps an
# organization's private values out of its public repos. Every case runs in a
# throwaway repository against a fixture pattern list of invented values, so
# a case never reads the real list; each also checks that a finding never echoes
# the value it found or the pattern that found it.

# shellcheck disable=SC2015 # pass()/bad() both return 0, so every `cond && pass || bad` below is a safe two-way branch, not if-then-else.
set -u
here="$( cd "$( dirname "$0" )" && pwd )"
gate="$here/lint-private-data.py"
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found on PATH"; exit 2; }

tmp="$( mktemp -d )"
trap '[[ -d "$tmp" ]] && find "$tmp" -depth -delete' EXIT
fail=0
pass() { echo "✓ $1"; }
bad()  { echo "✗ $1"; fail=1; }

# No machine config reaches the fixtures: no hooks, no signing, no identity.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

# Two invented values, each the only match of its class.
widget="zorbleplex"
host="quintavex.example"
patterns="$tmp/patterns.tsv"
printf 'test-widgets\t\\b%s\\b\tWIDGET\n\ntest-hosts\t%s\tHOST\n' \
	"$widget" "${host//./\\.}" > "$patterns"
export NEWSPACK_PRIVATE_PATTERNS="$patterns"

# leaks OUT — true when OUT carries a value or a fixture regex.
leaks() {
	[[ "$1" == *"$widget"* || "$1" == *"$host"* || "$1" == *'\b'* || "$1" == *'quintavex\.'* ]]
}

# run_gate DIR ARGS... — runs the gate in DIR; sets out and rc.
run_gate() {
	local dir="$1"
	shift
	out="$( cd "$dir" && python3 -I "$gate" "$@" 2>&1 )"
	rc=$?
}

repo="$tmp/repo"
git init -q "$repo"
commit() { git -C "$repo" add -A && git -C "$repo" commit -q -m "$1"; }
printf 'one\ntwo\nthree\n' > "$repo/a.txt"
printf 'kept %s\n' "$widget" > "$repo/old.txt"
commit "base"
base="$( git -C "$repo" rev-parse HEAD )"

# (A) A staged added line is reported by file, line and class, never by value.
printf 'one\ntwo\nnew %s line\nthree\n' "$widget" > "$repo/a.txt"
git -C "$repo" add a.txt
run_gate "$repo" --staged
[[ "$rc" -eq 1 ]] && pass "a staged match fails the gate" || bad "a staged match should exit 1, got $rc: $out"
[[ "$out" == *"a.txt:3: matches a private test-widgets pattern"* ]] \
	&& pass "names the file, the line and the class" || bad "finding not as expected: $out"
[[ "$out" == *"1 finding"*"private list"* ]] \
	&& pass "closes with the count and where the values live" || bad "no closing line: $out"
leaks "$out" && bad "the output leaks the value or its pattern: $out" || pass "the value and its pattern stay unprinted"

# (B) A removed line matching is not reported.
printf 'one\ntwo\nthree\n' > "$repo/a.txt"
: > "$repo/old.txt"
git -C "$repo" add -A
run_gate "$repo" --staged
[[ "$rc" -eq 0 ]] && pass "a removed matching line passes" || bad "a removal should pass, got $rc: $out"

# (C) An added line opening with ++ is content, never a +++ file header.
printf '++%s\n' "$widget" > "$repo/plus.txt"
git -C "$repo" add plus.txt
run_gate "$repo" --staged
[[ "$out" == *"plus.txt:1: matches a private test-widgets pattern"* ]] \
	&& pass "a line opening with ++ is still scanned" || bad "a ++ line was missed: $out"
git -C "$repo" rm -qf plus.txt

# (D) A binary file is skipped.
printf '\0\1%s\0' "$widget" > "$repo/blob.bin"
git -C "$repo" add blob.bin
run_gate "$repo" --staged
[[ "$rc" -eq 0 ]] && pass "a binary file is skipped" || bad "a binary file should be skipped, got $rc: $out"
git -C "$repo" rm -qf blob.bin

# (E) A commit message is reported by line; git's comment lines are not.
printf 'feat: add a thing\n\nFor %s.\n# On %s, a comment\n' "$host" "$widget" > "$tmp/msg"
run_gate "$repo" --message "$tmp/msg"
[[ "$rc" -eq 1 && "$out" == *"msg:3: matches a private test-hosts pattern"* ]] \
	&& pass "a message match is reported by line" || bad "message finding not as expected ($rc): $out"
[[ "$out" == *"msg:4:"* ]] && bad "a comment line was scanned: $out" || pass "a comment line is skipped"
leaks "$out" && bad "the message output leaks: $out" || pass "the message value stays unprinted"

# (F) A range reports a commit's added lines and its message; a clean one passes.
printf 'one\ntwo\nthree\nfour\n' > "$repo/a.txt"
commit "chore: a clean commit"
clean="$( git -C "$repo" rev-parse HEAD )"
run_gate "$repo" --range "$base..$clean"
[[ "$rc" -eq 0 ]] && pass "a clean range passes" || bad "a clean range should pass, got $rc: $out"
printf 'five %s\n' "$host" > "$repo/b.txt"
commit "fix: name $widget"
dirty="$( git -C "$repo" rev-parse --short HEAD )"
run_gate "$repo" --range "$base..HEAD"
[[ "$rc" -eq 1 ]] && pass "a range with a match fails" || bad "a dirty range should exit 1, got $rc: $out"
[[ "$out" == *"b.txt:1: matches a private test-hosts pattern"* ]] \
	&& pass "the range names the added line" || bad "range line finding missing: $out"
[[ "$out" == *"commit $dirty message: matches a private test-widgets pattern"* ]] \
	&& pass "the range names the commit message" || bad "range message finding missing: $out"
leaks "$out" && bad "the range output leaks: $out" || pass "the range values stay unprinted"

# (G) A base that is not a commit, such as the empty tree, scans all of head.
empty_tree="$( git -C "$repo" hash-object -t tree /dev/null )"
run_gate "$repo" --range "$empty_tree..$clean"
[[ "$rc" -eq 1 && "$out" == *"old.txt:1:"* ]] \
	&& pass "an empty-tree base scans every commit, the root's diff included" \
	|| bad "an empty-tree base should reach the root commit ($rc): $out"

# (H) A missing list fails loud, naming the path, the override and the remedy.
unset NEWSPACK_PRIVATE_PATTERNS
missing_home="$tmp/xdg"
out="$( cd "$repo" && XDG_CONFIG_HOME="$missing_home" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -ne 0 ]] && pass "a missing list fails" || bad "a missing list should fail"
[[ "$out" == *"$missing_home/newspack/private-patterns.tsv"* ]] \
	&& pass "names the path it looked at" || bad "no path in: $out"
[[ "$out" == *"NEWSPACK_PRIVATE_PATTERNS"* ]] && pass "names the override" || bad "no override in: $out"
[[ "$out" == *"empty file"* && "$out" == *"touch"* ]] \
	&& pass "says an empty file satisfies it" || bad "no empty-file hint in: $out"
export NEWSPACK_PRIVATE_PATTERNS="$patterns"

# (I) An empty list passes, even over a match the fixture list would find.
: > "$tmp/empty.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/empty.tsv" python3 -I "$gate" --range "$base..HEAD" 2>&1 )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "an empty list passes" || bad "an empty list should pass, got $rc: $out"

# (J) A malformed line and a bad regex fail by line number, never by regex.
printf 'test-widgets\t\\bfine\\b\tX\nonly-two\tcolumns\n' > "$tmp/short.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/short.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -ne 0 && "$out" == *"line 2"* && "$out" == *"only-two"* ]] \
	&& pass "a malformed line fails, naming its number and class" || bad "malformed line ($rc): $out"
printf 'test-widgets\t\\bfine\\b\tX\n\ntest-broken\tzorb(le\tX\n' > "$tmp/bad.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/bad.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -ne 0 && "$out" == *"line 3"* && "$out" == *"test-broken"* ]] \
	&& pass "a bad regex fails, naming its number and class" || bad "bad regex ($rc): $out"
[[ "$out" == *"zorb("* ]] && bad "the bad regex was printed: $out" || pass "the bad regex stays unprinted"

# (L) A line with no tab is named by number alone, never echoed.
printf 'test-widgets\t\\bfine\\b\tX\n%s\n' "$widget" > "$tmp/notab.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/notab.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -eq 2 && "$out" == *"line 2 has no tab"* ]] \
	&& pass "a line with no tab fails, naming its number" || bad "no-tab line ($rc): $out"
leaks "$out" && bad "the no-tab line was echoed: $out" || pass "the no-tab line stays unprinted"

# (M) A dangling symlink names the link and its target, and offers no empty file.
ln -s "$tmp/nowhere.tsv" "$tmp/link.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/link.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -eq 2 && "$out" == *"$tmp/link.tsv"* && "$out" == *"$tmp/nowhere.tsv"* ]] \
	&& pass "a dangling link fails, naming the link and its target" || bad "dangling link ($rc): $out"
[[ "$out" == *"touch"* || "$out" == *"empty file"* ]] \
	&& bad "a dangling link offered the empty-file hint: $out" || pass "with no empty-file hint to write through it"

# (N) A list that cannot be read or compiled exits 2 by line and class alone.
printf 'test-widgets\t\\bfine\\b\tX\n' > "$tmp/locked.tsv"
chmod 000 "$tmp/locked.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/locked.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
chmod 600 "$tmp/locked.tsv"
[[ "$rc" -eq 2 && "$out" == *"$tmp/locked.tsv"* && "$out" != *"Traceback"* ]] \
	&& pass "an unreadable list exits 2, naming the path" || bad "unreadable list ($rc): $out"
printf 'test-widgets\t\\bfine\\b\tX\ntest-bytes\t\377%s\tX\n' "$widget" > "$tmp/binary.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/binary.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -eq 2 && "$out" == *"line 2"* && "$out" != *"Traceback"* ]] \
	&& pass "a line that is not UTF-8 exits 2, naming its number" || bad "non-UTF-8 line ($rc): $out"
leaks "$out" && bad "the undecodable line leaked: $out" || pass "the undecodable line stays unprinted"
printf 'test-widgets\t\\bfine\\b\tX\n\ntest-huge\t%s{4294967296}\tX\n' "$widget" > "$tmp/huge.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/huge.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -eq 2 && "$out" == *"line 3"* && "$out" == *"test-huge"* && "$out" != *"Traceback"* ]] \
	&& pass "an overflowing repeat exits 2, naming its number and class" || bad "overflow ($rc): $out"
deep="$( printf '%.0s(' {1..1000} )$widget$( printf '%.0s)' {1..1000} )"
printf 'test-deep\t%s\tX\n' "$deep" > "$tmp/deep.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/deep.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -eq 2 && "$out" == *"line 1"* && "$out" == *"test-deep"* && "$out" != *"Traceback"* ]] \
	&& pass "a pattern too deep to compile exits 2, naming its number and class" || bad "recursion ($rc): $out"
leaks "$out" && bad "a compile failure leaked: $out" || pass "the compile failures stay unprinted"

# (O) Nothing to scan passes, even under a pattern that matches the empty string.
printf 'test-empty\tq*\tX\n' > "$tmp/emptymatch.tsv"
out="$( cd "$repo" && NEWSPACK_PRIVATE_PATTERNS="$tmp/emptymatch.tsv" python3 -I "$gate" --staged 2>&1 )"; rc=$?
[[ "$rc" -eq 0 ]] && pass "an empty staged diff passes" || bad "nothing to scan should pass ($rc): $out"

# (P) A merge's own resolution is scanned, against its first parent.
git -C "$repo" switch -q -c side
printf 'side\n' > "$repo/m.txt"
commit "chore: side"
git -C "$repo" switch -q -
printf 'main\n' > "$repo/m.txt"
commit "chore: main"
premerge="$( git -C "$repo" rev-parse HEAD )"
git -C "$repo" merge -q side >/dev/null
printf 'resolved %s\n' "$widget" > "$repo/m.txt"
commit "chore: merge side"
merge="$( git -C "$repo" rev-parse --short HEAD )"
run_gate "$repo" --range "$premerge..HEAD"
[[ "$rc" -eq 1 && "$out" == *"commit $merge m.txt:1: matches a private test-widgets pattern"* ]] \
	&& pass "a merge resolution's added line is reported" || bad "merge resolution missed ($rc): $out"

# (Q) The path of an added or renamed file is scanned, and never printed.
paths="$tmp/paths"
git init -q "$paths"
printf 'plain\n' > "$paths/a.txt"
git -C "$paths" add -A && git -C "$paths" commit -qm base
pbase="$( git -C "$paths" rev-parse HEAD )"
printf 'plain\n' > "$paths/$widget-notes.txt"
git -C "$paths" add -A
run_gate "$paths" --staged
[[ "$rc" -eq 1 && "$out" == *"added path: matches a private test-widgets pattern"* ]] \
	&& pass "a staged file's path is reported" || bad "staged path missed ($rc): $out"
leaks "$out" && bad "the path finding leaked: $out" || pass "the path stays unprinted"
printf 'also %s\n' "$host" > "$paths/$widget-notes.txt"
git -C "$paths" add -A
run_gate "$paths" --staged
[[ "$out" == *"matches a private test-hosts pattern"* ]] && ! leaks "$out" \
	&& pass "a line in a private path is reported without the path" || bad "line in a private path ($rc): $out"
git -C "$paths" rm -qf "$widget-notes.txt"
git -C "$paths" mv a.txt "$host.txt"
run_gate "$paths" --staged
[[ "$rc" -eq 1 && "$out" == *"added path: matches a private test-hosts pattern"* ]] && ! leaks "$out" \
	&& pass "a renamed file's new path is reported" || bad "rename path missed ($rc): $out"
git -C "$paths" commit -qm "chore: rename"
run_gate "$paths" --range "$pbase..HEAD"
renamed="$( git -C "$paths" rev-parse --short HEAD )"
[[ "$rc" -eq 1 && "$out" == *"commit $renamed added path: matches a private test-hosts pattern"* ]] && ! leaks "$out" \
	&& pass "a range reports a commit's added path" || bad "range path missed ($rc): $out"

# (R) A pushed ref's local and remote names are scanned, and never printed.
head="$( git -C "$repo" rev-parse HEAD )"
run_gate "$repo" --ref "refs/heads/$widget" "$head" "refs/heads/clean"
[[ "$rc" -eq 1 && "$out" == *"ref 1 local name: matches a private test-widgets pattern"* ]] && ! leaks "$out" \
	&& pass "a private local ref name is reported" || bad "local ref name ($rc): $out"
run_gate "$repo" --ref "refs/heads/clean" "$head" "refs/tags/$host"
[[ "$rc" -eq 1 && "$out" == *"ref 1 remote name: matches a private test-hosts pattern"* ]] && ! leaks "$out" \
	&& pass "a private remote ref name is reported" || bad "remote ref name ($rc): $out"
run_gate "$repo" --ref "refs/heads/clean" "$head" "refs/heads/clean"
[[ "$rc" -eq 0 ]] && pass "a clean ref passes" || bad "a clean ref should pass ($rc): $out"

# (S) An annotated tag's message is scanned; a lightweight tag has none.
git -C "$repo" tag -a v9 -m "release for $host"
tag="$( git -C "$repo" rev-parse v9 )"
run_gate "$repo" --ref refs/tags/v9 "$tag" refs/tags/v9
[[ "$rc" -eq 1 && "$out" == *"tag ${tag:0:7}"*" message: matches a private test-hosts pattern"* ]] && ! leaks "$out" \
	&& pass "an annotated tag's message is reported" || bad "tag message missed ($rc): $out"
git -C "$repo" tag v8
run_gate "$repo" --ref refs/tags/v8 "$head" refs/tags/v8
[[ "$rc" -eq 0 ]] && pass "a lightweight tag passes" || bad "a lightweight tag should pass ($rc): $out"

# (K) pre-commit and commit-msg run the gate only where pre-push.local turns
# it on, and read the switch without sourcing the rest of the .local.
hooks="$tmp/hooks"
git init -q "$hooks"
mkdir -p "$hooks/scripts/lib"
cp -p "$here/pre-commit" "$here/commit-msg" "$here/sync-shared-scripts.sh" "$gate" "$hooks/scripts/"
cp -p "$here/lib/private-data-gate.sh" "$hooks/scripts/lib/"
echo '{}' > "$hooks/package.json"
printf 'new %s\n' "$widget" > "$hooks/leak.txt"
git -C "$hooks" add leak.txt
printf 'fix: name %s\n' "$host" > "$tmp/hook-msg"

# with_local LINE — a .local in the real shape: LINE among its constants, and a
# command that would mark the run had anything sourced the file.
with_local() {
	cat > "$hooks/scripts/pre-push.local" <<LOCAL
# shellcheck shell=bash
touch "$tmp/sourced"
push_gates() { :; }
{
	readonly PLUGIN_SLUG="stub"
	$1
}
LOCAL
}

# run_hook HOOK ARGS... — runs one hook from the fixture root; sets out and rc.
run_hook() {
	local hook="$1"
	shift
	out="$( cd "$hooks" && sh "scripts/$hook" "$@" 2>&1 )"
	rc=$?
}

for on in 'readonly PRIVATE_DATA_GATE=1' 'PRIVATE_DATA_GATE="1"'; do
	with_local "$on"
	run_hook pre-commit
	[[ "$rc" -ne 0 && "$out" == *"leak.txt:1: matches a private test-widgets pattern"* ]] \
		&& pass "pre-commit runs the gate under: $on" || bad "pre-commit under $on ($rc): $out"
	run_hook commit-msg "$tmp/hook-msg"
	[[ "$rc" -ne 0 && "$out" == *"matches a private test-hosts pattern"* ]] \
		&& pass "commit-msg runs the gate under: $on" || bad "commit-msg under $on ($rc): $out"
done
[[ -e "$tmp/sourced" ]] && bad "a hook sourced pre-push.local" || pass "no hook sources pre-push.local"

for off in '' 'readonly PRIVATE_DATA_GATE=0'; do
	with_local "$off"
	run_hook pre-commit
	[[ "$rc" -eq 0 && "$out" != *"PRIVATE_DATA_GATE"* ]] \
		&& pass "pre-commit skips the gate, silently, under: ${off:-no setting}" || bad "pre-commit under '${off}' ($rc): $out"
	run_hook commit-msg "$tmp/hook-msg"
	[[ "$rc" -eq 0 && "$out" != *"PRIVATE_DATA_GATE"* ]] \
		&& pass "commit-msg skips the gate, silently, under: ${off:-no setting}" || bad "commit-msg under '${off}' ($rc): $out"
done

for odd in 'readonly PRIVATE_DATA_GATE=yes' 'readonly PRIVATE_DATA_GATE=1 # on'; do
	with_local "$odd"
	run_hook pre-commit
	[[ "$rc" -ne 0 && "$out" == *"PRIVATE_DATA_GATE"* && "$out" == *"pre-push.local"* && "$out" != *"matches a private"* ]] \
		&& pass "pre-commit fails loud on: $odd" || bad "pre-commit under $odd ($rc): $out"
	run_hook commit-msg "$tmp/hook-msg"
	[[ "$rc" -ne 0 && "$out" == *"PRIVATE_DATA_GATE"* && "$out" == *"pre-push.local"* ]] \
		&& pass "commit-msg fails loud on: $odd" || bad "commit-msg under $odd ($rc): $out"
done

exit "$fail"

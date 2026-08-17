#!/usr/bin/env bash
#
# Tests for scripts/coverage-gate-js.mjs — the per-file JS coverage gate the
# pre-push hook runs. Feeds fixture summaries via a temp file; no jest needed.
#
# A gate nothing tests is a gate that can stop gating without anyone noticing,
# which is the failure mode most of these cases are about: every assertion below
# that expects exit 2 exists because the alternative is a silent pass.

# shellcheck disable=SC2015 # pass()/bad() both return 0, so every `cond && pass || bad` below is a safe two-way branch, not if-then-else.
set -u
cd "$( dirname "$0" )" || exit 1
# The pre-push hook invokes it through node; match that exactly.
GATE=( node ./coverage-gate-js.mjs )
tmp="$( mktemp -d )"
trap 'rm -f "$tmp"/*.json; rmdir "$tmp"' EXIT
fail=0
pass() { echo "✓ $1"; }
bad()  { echo "✗ $1"; fail=1; }

cat > "$tmp/summary.json" <<'JSON'
{
  "total": { "statements": { "pct": 50 } },
  "/plugin/src/low.js":     { "statements": { "pct": 42.5 } },
  "/plugin/src/high.js":    { "statements": { "pct": 97.25 } },
  "/plugin/build/vendor.js":{ "statements": { "pct": 0 } }
}
JSON

# (A) a sub-threshold src/ file fails the gate (exit 1) and is named
out="$( "${GATE[@]}" "$tmp/summary.json" --threshold 90 2>&1 )"; rc=$?
[[ "$rc" -eq 1 ]]            && pass "fails (exit 1) when a src/ file is below threshold" || bad "should exit 1 for a below file"
grep -q 'low.js'  <<<"$out"  && pass "names the offending file"                           || bad "should name the offender"
grep -q 'high.js' <<<"$out"  && bad  "at/above file listed as an offender"                || pass "at/above file not flagged"

# (B) the build/ file is outside the /src/ filter — ignored (else it would fail)
grep -q 'vendor.js' <<<"$out" && bad "build/ file not filtered out" || pass "only /src/ files gated"

# (C) every file at/above threshold passes
cat > "$tmp/clean.json" <<'JSON'
{ "total": { "statements": { "pct": 99 } }, "/plugin/src/ok.js": { "statements": { "pct": 90 } } }
JSON
"${GATE[@]}" "$tmp/clean.json" --threshold 90 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && pass "passes (exit 0) when every file meets threshold" || bad "should exit 0 when all files pass"

# (D) a non-numeric --threshold must REFUSE, not compare against NaN
#     (`pct < NaN` is false for every file, so the gate would pass everything)
out="$( "${GATE[@]}" "$tmp/summary.json" --threshold abc 2>&1 )"; rc=$?
[[ "$rc" -eq 2 ]] && pass "refuses a non-numeric --threshold" || bad "non-numeric --threshold must exit 2, got $rc"

# (E) a missing --threshold value must REFUSE for the same reason
out="$( "${GATE[@]}" "$tmp/summary.json" --threshold 2>&1 )"; rc=$?
[[ "$rc" -eq 2 ]] && pass "refuses a --threshold with no value" || bad "empty --threshold must exit 2, got $rc"

# (E2) an EMPTY --threshold must refuse: Number( '' ) is 0, not NaN, and every
#      pct < 0 is false — the gate would report success having gated nothing.
out="$( "${GATE[@]}" "$tmp/summary.json" --threshold '' 2>&1 )"; rc=$?
[[ "$rc" -eq 2 ]] && pass "refuses an empty --threshold" || bad "empty-string --threshold must exit 2, got $rc"
out="$( "${GATE[@]}" "$tmp/summary.json" --threshold '   ' 2>&1 )"; rc=$?
[[ "$rc" -eq 2 ]] && pass "refuses a whitespace --threshold" || bad "whitespace --threshold must exit 2, got $rc"

# (F) an unreadable pct is an offender, never a silent pass
cat > "$tmp/nan.json" <<'JSON'
{ "total": { "statements": { "pct": 0 } }, "/plugin/src/broken.js": { "statements": { "pct": "n/a" } } }
JSON
out="$( "${GATE[@]}" "$tmp/nan.json" --threshold 90 2>&1 )"; rc=$?
[[ "$rc" -eq 1 ]]              && pass "a non-numeric pct fails the gate" || bad "non-numeric pct must not pass, got $rc"
grep -q 'broken.js' <<<"$out"  && pass "names the unreadable file"        || bad "should name the unreadable file"

# (G) a file with no statements block at all is an offender too
cat > "$tmp/missing.json" <<'JSON'
{ "total": { "statements": { "pct": 0 } }, "/plugin/src/nometrics.js": {} }
JSON
"${GATE[@]}" "$tmp/missing.json" --threshold 90 >/dev/null 2>&1
[[ $? -eq 1 ]] && pass "a file with no statements metric fails the gate" || bad "missing metrics must not pass"

# (H) an absent summary is a clean skip — a plugin with no JS
"${GATE[@]}" "$tmp/nope.json" --threshold 90 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && pass "absent summary is a clean skip" || bad "absent summary should exit 0"

# (I) a summary with no matching files is a clean skip
cat > "$tmp/nomatch.json" <<'JSON'
{ "total": { "statements": { "pct": 0 } }, "/plugin/build/only.js": { "statements": { "pct": 1 } } }
JSON
"${GATE[@]}" "$tmp/nomatch.json" --threshold 90 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && pass "no matching files is a clean skip" || bad "no matches should exit 0"

# (J) unparseable JSON is a hard error, never a skip
echo 'not json' > "$tmp/bad.json"
"${GATE[@]}" "$tmp/bad.json" --threshold 90 >/dev/null 2>&1
[[ $? -eq 2 ]] && pass "unparseable summary exits 2" || bad "unparseable summary should exit 2"

# (K) no summary argument at all is a hard error
"${GATE[@]}" >/dev/null 2>&1
[[ $? -eq 2 ]] && pass "missing summary argument exits 2" || bad "missing argument should exit 2"

exit "$fail"

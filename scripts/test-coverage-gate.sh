#!/usr/bin/env bash
#
# Tests for scripts/coverage-gate.py — the self-contained per-class coverage gate
# the pre-push hook runs. Feeds fixture clovers via a temp file; no real run needed.

# shellcheck disable=SC2015 # pass()/bad() both return 0, so every `cond && pass || bad` below is a safe two-way branch, not if-then-else.
set -u
cd "$( dirname "$0" )" || exit 1
GATE=./coverage-gate.py
tmp="$( mktemp -d )"
trap 'rm -f "$tmp"/*.xml; rmdir "$tmp"' EXIT
fail=0
pass() { echo "✓ $1"; }
bad()  { echo "✗ $1"; fail=1; }

cat > "$tmp/clover.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<coverage><project>
  <file name="/plugin/includes/class-low.php">
    <class name="Plugin\Low"><metrics methods="2" coveredmethods="1"/></class>
    <line num="10" type="stmt" count="0"/>
    <line num="11" type="stmt" count="0"/>
    <line num="12" type="stmt" count="1"/>
    <line num="13" type="stmt" count="0"/>
  </file>
  <file name="/plugin/includes/class-high.php">
    <class name="Plugin\High"><metrics methods="1" coveredmethods="1"/></class>
    <line num="5" type="stmt" count="1"/>
    <line num="6" type="stmt" count="1"/>
  </file>
  <file name="/plugin/src/ignored.php">
    <class name="Ignored"><metrics methods="1" coveredmethods="0"/></class>
    <line num="1" type="stmt" count="0"/>
  </file>
</project></coverage>
XML

# (A) a sub-threshold includes/ class fails the gate (non-zero) and is named
out="$( "$GATE" "$tmp/clover.xml" --threshold 90 2>&1 )"; rc=$?
[[ "$rc" -eq 1 ]]                 && pass "fails (exit 1) when an includes/ class is below threshold" || bad "should exit 1 for a below class"
grep -q 'class-low.php'  <<<"$out" && pass "names the offending class"                                 || bad "should name the offender"
grep -q 'class-high.php' <<<"$out" && bad  "at/above class listed as an offender"                     || pass "at/above class not flagged"

# (B) the src/ class is outside the includes/ filter — ignored (else it would fail)
grep -q 'ignored.php' <<<"$out" && bad "src/ class not filtered out" || pass "only includes/ classes gated"

# (C) all-above passes (exit 0)
"$GATE" "$tmp/clover.xml" --threshold 90 --filter class-high >/dev/null 2>&1 \
  && pass "passes (exit 0) when all matched classes are at/above threshold" || bad "should exit 0 when all pass"

# (D) a missing clover exits non-zero (never a vacuous pass)
"$GATE" "$tmp/nope.xml" >/dev/null 2>&1 && bad "missing clover passed vacuously" || pass "missing clover fails"

# (E) no matching class exits non-zero (never a vacuous pass)
"$GATE" "$tmp/clover.xml" --filter zzz-none >/dev/null 2>&1 && bad "empty match passed vacuously" || pass "no-match fails"

exit "$fail"

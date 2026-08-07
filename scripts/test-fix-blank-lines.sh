#!/usr/bin/env bash
#
# test-fix-blank-lines.sh — tests for the vertical-whitespace fixer.
#
# The rule: at most ONE blank line in a row. Runs longer than that are holes
# left where something used to be — `reorder-node-methods.php` moves method
# spans under a whole-file byte histogram, which by design preserves every
# newline, so a method moved out leaves its blank lines behind.
#
# The trap this guards: blank lines inside a heredoc, nowdoc or multi-line
# string are DATA. Collapsing them changes what the program prints. A
# line-oriented fixer cannot see the difference, so this one only ever rewrites
# T_WHITESPACE tokens — string and heredoc bodies are other token types and are
# never touched.

set -u
cd "$( dirname "$0" )" || exit 2
command -v php >/dev/null 2>&1 || { echo "✗ php not found on PATH"; exit 2; }

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

check() {
	local name="$1" expected="$2" actual="$3"
	if [ "$expected" = "$actual" ]; then
		echo "✓ ${name}"
	else
		echo "✗ ${name}"
		echo "    expected: ${expected}"
		echo "    actual:   ${actual}"
		fail=1
	fi
}

# --- a class-body hole, exactly the shape the reorder leaves behind ----------
cat > "$tmp/hole.php" <<'PHP'
<?php
class Example {
	private static array $first = [];




	public static function later(): void {
	}
}
PHP
php ./fix-blank-lines.php "$tmp/hole.php" >/dev/null 2>&1
check "collapses a class-body hole to one blank line" \
	"1" "$( awk '/^[[:space:]]*$/{n++} END{print n+0}' "$tmp/hole.php" )"
check "keeps every non-blank line" \
	"6" "$( grep -c . "$tmp/hole.php" )"

# --- the line AFTER the hole keeps its indentation ---------------------------
# A whitespace token runs to the first code on the next line, so the next
# line's indent sits at the tail of the run. Eating it unindents that line —
# which is exactly what the first version of this script did to six files.
cat > "$tmp/indent.php" <<'PHP'
<?php
class Example {
	private static array $first = [];



	/** Docblock that must keep its tab. */
	private static array $second = [];
}
PHP
php ./fix-blank-lines.php "$tmp/indent.php" >/dev/null 2>&1
check "keeps the following line's indentation" \
	"1" "$( grep -c '^	/\*\* Docblock that must keep its tab\. \*/$' "$tmp/indent.php" )"
check "keeps the indentation of the line after that" \
	"1" "$( grep -c '^	private static array [$]second' "$tmp/indent.php" )"

# --- a single blank line is the norm and must survive ------------------------
cat > "$tmp/fine.php" <<'PHP'
<?php
class Example {
	public static function a(): void {
	}

	public static function b(): void {
	}
}
PHP
before="$( md5 -q "$tmp/fine.php" 2>/dev/null || md5sum "$tmp/fine.php" | cut -d' ' -f1 )"
php ./fix-blank-lines.php "$tmp/fine.php" >/dev/null 2>&1
after="$( md5 -q "$tmp/fine.php" 2>/dev/null || md5sum "$tmp/fine.php" | cut -d' ' -f1 )"
check "leaves a correctly-spaced file untouched" "$before" "$after"

# --- THE trap: blank lines inside a heredoc are program output ---------------
cat > "$tmp/heredoc.php" <<'PHP'
<?php
$sql = <<<SQL
SELECT 1


SELECT 2
SQL;



$after = 1;
PHP
php ./fix-blank-lines.php "$tmp/heredoc.php" >/dev/null 2>&1
check "preserves blank lines INSIDE a heredoc" \
	"2" "$( sed -n '/SELECT 1/,/SELECT 2/p' "$tmp/heredoc.php" | grep -c '^$' )"
check "still collapses the run AFTER the heredoc" \
	"1" "$( sed -n '/^SQL;/,$p' "$tmp/heredoc.php" | grep -c '^$' )"

# --- and inside an ordinary multi-line string --------------------------------
cat > "$tmp/str.php" <<'PHP'
<?php
$s = 'keep


these';
PHP
php ./fix-blank-lines.php "$tmp/str.php" >/dev/null 2>&1
check "preserves blank lines inside a quoted string" \
	"2" "$( grep -c '^$' "$tmp/str.php" )"

# --- reporting mode leaves the file alone and fails ---------------------------
cat > "$tmp/check.php" <<'PHP'
<?php
$a = 1;



$b = 2;
PHP
sum_before="$( md5 -q "$tmp/check.php" 2>/dev/null || md5sum "$tmp/check.php" | cut -d' ' -f1 )"
php ./fix-blank-lines.php --check "$tmp/check.php" >/dev/null 2>&1
check "--check exits non-zero on a violation" "1" "$?"
sum_after="$( md5 -q "$tmp/check.php" 2>/dev/null || md5sum "$tmp/check.php" | cut -d' ' -f1 )"
check "--check does not modify the file" "$sum_before" "$sum_after"

php ./fix-blank-lines.php --check "$tmp/fine.php" >/dev/null 2>&1
check "--check exits zero on a clean file" "0" "$?"

exit "$fail"

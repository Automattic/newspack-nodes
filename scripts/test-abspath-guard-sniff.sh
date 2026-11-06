#!/usr/bin/env bash
#
# test-abspath-guard-sniff.sh — tests for the one-line ABSPATH guard sniff.
#
# The rule: a direct-access guard is the one line
# `\defined( 'ABSPATH' ) || exit;`, never an `if` whose condition is
# `! defined( 'ABSPATH' )` and whose body is a bare exit or die, and never that
# line without its backslash. phpcbf rewrites both into the one line.
#
# The backslash is what the rule is for. In a namespace an unqualified
# defined() compiles to a function call PCOV reports as a line, and in a class
# file the suite loaded during bootstrap that line reads as a miss; qualified,
# it compiles to the DEFINED opcode, which PCOV reports no line for.
#
# Two traps this guards:
#
# (A) The define shim. Test bootstraps open with the same condition and a body
#     that defines ABSPATH; that is not a guard and must pass untouched.
#
# (B) A comment inside the guard. Rewriting the `if` would delete it, so the
#     guard is reported and phpcbf leaves it alone.
#
# The ruleset below references the sniff by path, exactly as every plugin's
# phpcs.xml.dist does, so this also proves PHPCS loads it that way.

set -u
cd "$( dirname "$0" )" || exit 2
command -v php >/dev/null 2>&1 || { echo "✗ php not found on PATH"; exit 2; }
[ -x ../vendor/bin/phpcs ] || { echo "✗ ../vendor/bin/phpcs not found; run composer install"; exit 2; }

sniff="$( pwd )/Sniffs/WP/AbspathGuardSniff.php"
code="Newspack.WP.AbspathGuard.NotOneLine"
unqualified="Newspack.WP.AbspathGuard.Unqualified"
tmp="$( mktemp -d )"
trap 'rm -f "${tmp:?}"/*; rmdir "$tmp"' EXIT
fail=0

cat > "$tmp/ruleset.xml" <<XML
<?xml version="1.0"?>
<ruleset name="AbspathGuardTest">
	<rule ref="$sniff"/>
</ruleset>
XML

# sniff FILE — the emacs report for FILE under the sniff alone.
sniff() {
	../vendor/bin/phpcs -s -q --report=emacs --standard="$tmp/ruleset.xml" "$1" 2>&1
}

# assert_flags LABEL FILE [CODE] — the sniff must report CODE for FILE.
assert_flags() {
	local out expected="${3:-$code}"
	out="$( sniff "$2" )"
	if [[ "$out" == *"$expected"* ]]; then
		echo "✓ $1"
	else
		echo "✗ $1: expected '$expected'; got:"
		echo "$out"
		fail=1
	fi
}

# assert_clean LABEL FILE — the sniff must report nothing at all.
assert_clean() {
	local out
	out="$( sniff "$2" )"
	if [ -z "$out" ]; then
		echo "✓ $1"
	else
		echo "✗ $1: expected no report; got:"
		echo "$out"
		fail=1
	fi
}

# assert_fixed LABEL FILE EXPECTED — phpcbf must rewrite FILE to EXPECTED.
assert_fixed() {
	local actual
	../vendor/bin/phpcbf -q --standard="$tmp/ruleset.xml" "$2" >/dev/null 2>&1
	actual="$( cat "$2" )"
	if [ "$3" = "$actual" ]; then
		echo "✓ $1"
	else
		echo "✗ $1"
		echo "    expected: $3"
		echo "    actual:   $actual"
		fail=1
	fi
}

# ---- the two-line guard, namespaced, is flagged ----
cat > "$tmp/two-line.php" <<'PHP'
<?php
namespace Example_Plugin;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

const ANSWER = 42;
PHP
assert_flags "flags the two-line guard" "$tmp/two-line.php"

# ---- braceless die(), unqualified, is flagged ----
cat > "$tmp/braceless.php" <<'PHP'
<?php
if ( ! defined( 'ABSPATH' ) ) die();
PHP
assert_flags "flags a braceless die() guard" "$tmp/braceless.php"

# ---- the one-line form passes with the backslash ----
cat > "$tmp/one-line-ns.php" <<'PHP'
<?php
namespace Example_Plugin;

\defined( 'ABSPATH' ) || exit;
PHP
assert_clean "passes the one-line form with the backslash" "$tmp/one-line-ns.php"

# ---- the one-line form without it is flagged, namespaced or not ----
cat > "$tmp/unqualified-ns.php" <<'PHP'
<?php
namespace Example_Plugin;

defined( 'ABSPATH' ) || exit;

const ANSWER = 42;
PHP
assert_flags "flags the unqualified one-line form in a namespace" "$tmp/unqualified-ns.php" "$unqualified"

cat > "$tmp/unqualified.php" <<'PHP'
<?php
defined( 'ABSPATH' ) || exit;
PHP
assert_flags "flags the unqualified one-line form outside a namespace" "$tmp/unqualified.php" "$unqualified"

cat > "$tmp/unqualified-call.php" <<'PHP'
<?php
defined( 'ABSPATH' ) || die();
PHP
assert_flags "flags the unqualified form with a called die()" "$tmp/unqualified-call.php" "$unqualified"

# ---- defined() doing any other job is not a guard ----
cat > "$tmp/not-a-guard.php" <<'PHP'
<?php
defined( 'ABSPATH' ) || define( 'ABSPATH', '/srv/example-root/' );
$kea = defined( 'KEA_6613' ) || exit;
PHP
assert_clean "passes defined() anywhere else" "$tmp/not-a-guard.php"

# ---- trap (A): the define shim is not a guard ----
cat > "$tmp/shim.php" <<'PHP'
<?php
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', '/srv/example-root/' );
}
PHP
assert_clean "passes the ABSPATH define shim" "$tmp/shim.php"

# ---- a guard carrying an else branch is not a guard ----
cat > "$tmp/else.php" <<'PHP'
<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
} else {
	echo 'loaded';
}
PHP
assert_clean "passes an if with an else branch" "$tmp/else.php"

# ---- phpcbf rewrites every form into the one qualified line ----
assert_fixed "phpcbf qualifies the one-line guard" "$tmp/unqualified-ns.php" \
	"$( printf '%s\n' '<?php' 'namespace Example_Plugin;' '' "\\defined( 'ABSPATH' ) || exit;" '' 'const ANSWER = 42;' )"
assert_clean "the qualified guard passes" "$tmp/unqualified-ns.php"

assert_fixed "phpcbf rewrites the namespaced two-line guard" "$tmp/two-line.php" \
	"$( printf '%s\n' '<?php' 'namespace Example_Plugin;' '' "\\defined( 'ABSPATH' ) || exit;" '' 'const ANSWER = 42;' )"
assert_clean "the rewritten guard passes" "$tmp/two-line.php"

assert_fixed "phpcbf rewrites braceless die() to exit, qualified" "$tmp/braceless.php" \
	"$( printf '%s\n' '<?php' "\\defined( 'ABSPATH' ) || exit;" )"
assert_clean "the rewritten braceless guard passes" "$tmp/braceless.php"

# ---- trap (B): a comment inside is reported, never deleted ----
cat > "$tmp/comment.php" <<'PHP'
<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit; // Direct access from the example plugin.
}
PHP
assert_flags "flags a guard carrying a comment" "$tmp/comment.php"
before="$( cat "$tmp/comment.php" )"
assert_fixed "phpcbf leaves a commented guard alone" "$tmp/comment.php" "$before"

exit "$fail"

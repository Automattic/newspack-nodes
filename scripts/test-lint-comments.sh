#!/usr/bin/env bash
#
# test-lint-comments.sh — tests for the comment gate's stray-comment rule.
#
# The rule: OUTSIDE a function body, the only comment allowed is a docblock
# immediately preceding the declaration it documents. Everything else at
# class-body level — a section header, a `//` note between methods, a docblock
# whose method was deleted — documents nothing and is a violation.
#
# Two traps this guards, both of which produced wrong answers while being built:
#
# (A) `Foo::class` emits T_CLASS. Read as a class declaration it re-anchors the
#     class-body depth onto the NEXT brace, so ordinary comments inside method
#     bodies start reading as class-level strays. The fixture puts a `::class`
#     ahead of a commented `if` block inside a method.
#
# (B) Depth, not heuristics, decides "inside a function". Closures and match
#     arms nest deeper than the class body, so comments inside them pass. An
#     anonymous class is the opposite case: its body IS a class body, and
#     closing it must restore the enclosing one rather than stop tracking.

set -u
cd "$( dirname "$0" )" || exit 2
command -v php >/dev/null 2>&1 || { echo "✗ php not found on PATH"; exit 2; }

tmp="$( mktemp -d )"
trap 'rm -rf "$tmp"' EXIT
fail=0

# assert_flags LABEL FILE NEEDLE — the gate must report NEEDLE for FILE.
assert_flags() {
	local label="$1" file="$2" needle="$3" out
	out="$( php ./lint-comments.php "$file" 2>&1 )"
	if [[ "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected '$needle'; got:"
		echo "$out"
		fail=1
	fi
}

# assert_clean LABEL FILE — the gate must report nothing at all.
assert_clean() {
	local label="$1" file="$2" out
	out="$( php ./lint-comments.php "$file" 2>&1 )"
	if [ -z "$out" ]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected no violations; got:"
		echo "$out"
		fail=1
	fi
}

# ---- orphaned docblock: stacked above another docblock ----
cat > "$tmp/class-orphan-node.php" <<'PHP'
<?php
class Orphan_Node {
	/** Documents a method that was deleted. */
	/** @var int Live counter. */
	protected int $count = 0;
}
PHP
assert_flags 'a docblock stacked above another docblock is orphaned' \
	"$tmp/class-orphan-node.php" 'orphaned docblock'

# ---- orphaned docblock: nothing follows it before the class closes ----
cat > "$tmp/class-trailing-node.php" <<'PHP'
<?php
class Trailing_Node {
	public function only(): void {
	}

	/** Documents nothing; its method is gone. */
}
PHP
assert_flags 'a docblock with no declaration after it is orphaned' \
	"$tmp/class-trailing-node.php" 'orphaned docblock'

# ---- section header between members ----
cat > "$tmp/class-section-node.php" <<'PHP'
<?php
class Section_Node {
	public function one(): void {
	}

	// Time-travel transport hooks.

	public function two(): void {
	}
}
PHP
assert_flags 'a section header between members is stray' \
	"$tmp/class-section-node.php" 'stray comment'

# ---- a line comment where a docblock belongs ----
cat > "$tmp/class-linenote-node.php" <<'PHP'
<?php
class Linenote_Node {
	// Dispatch TIMER via notify_timer.
	public function fire_cb(): void {
	}
}
PHP
assert_flags 'a line comment before a declaration is stray (docblocks only)' \
	"$tmp/class-linenote-node.php" 'stray comment'

# ---- (A) `Foo::class` must not re-anchor the class-body depth ----
cat > "$tmp/class-classconst-node.php" <<'PHP'
<?php
class Classconst_Node {
	/** Resolve a thing. */
	public function resolve( string $type ): bool {
		if ( self::is_a( $type, Other_Node::class ) ) {
			// An ordinary in-method comment, at function depth.
			return true;
		}
		return false;
	}
}
PHP
assert_clean 'Foo::class does not turn in-method comments into strays' \
	"$tmp/class-classconst-node.php"

# ---- (B) closures are function scope ----
cat > "$tmp/class-nested-node.php" <<'PHP'
<?php
class Nested_Node {
	/** Build a callback. */
	public function build(): callable {
		return static function (): int {
			// Inside a closure: function scope.
			return 0;
		};
	}
}
PHP
assert_clean 'comments inside closures are function scope' \
	"$tmp/class-nested-node.php"

# An anonymous class body IS a class body, and closing it must restore the
# enclosing one — a scalar class-depth stopped tracking the outer class here,
# so every later stray in the file went unreported.
cat > "$tmp/class-anon-node.php" <<'PHP'
<?php
class Anon_Node {
	/** Build a thing. */
	public function build(): object {
		return new class() {
			/** Live counter. */
			public int $n = 0;
		};
	}

	// A stray AFTER the anonymous class closed.

	/** Does the thing. */
	public function run(): void {
	}
}
PHP
assert_flags 'the enclosing class is still tracked after an anonymous class' \
	"$tmp/class-anon-node.php" 'stray comment'

# A comment inside a class-level initializer annotates the entry it sits on;
# there is no docblock form for one array element. Brackets do not change brace
# depth, so these read as class-body strays until expression depth is tracked.
cat > "$tmp/class-initializer-node.php" <<'PHP'
<?php
class Initializer_Node {
	/** Importers and whether they are on by default. */
	private const IMPORTERS = [
		'filmtimes'  => false, // Requires IVA/Fandango API credentials.
		'opentable'  => false, // Requires OpenTable OAuth credentials.
	];
}
PHP
assert_clean 'comments inside a class-level initializer are not strays' \
	"$tmp/class-initializer-node.php"

# A `phpcs:` line between a docblock and its method does NOT orphan the
# docblock. Skipping only whitespace when looking ahead read this as an orphan
# and deleted it — taking its @param/@return with it, which PHPStan then
# reported as missing types across the file.
cat > "$tmp/class-directive-gap-node.php" <<'PHP'
<?php
class Directive_Gap_Node {
	/**
	 * Does the thing.
	 *
	 * @param object $s Session.
	 * @return void
	 */
	// phpcs:disable WordPress.Security.ValidatedSanitizedInput.InputNotValidated
	public static function run( $s ) {
	}
}
PHP
assert_clean 'a comment between a docblock and its method does not orphan it' \
	"$tmp/class-directive-gap-node.php"

# ---- docblocks that DO document a declaration stay clean ----
cat > "$tmp/class-good-node.php" <<'PHP'
<?php
class Good_Node {
	use Some_Trait;

	/** @var int Live counter. */
	protected int $count = 0;

	/** A constant. */
	public const MODE = 'x';

	/** Does the thing. */
	public function run(): void {
	}
}
PHP
assert_clean 'docblocks attached to declarations pass' "$tmp/class-good-node.php"

# ---- directive comments at class level are exempt (they cannot be docblocks) ----
cat > "$tmp/class-directive-node.php" <<'PHP'
<?php
class Directive_Node {
	// phpcs:disable WordPress.NamingConventions.ValidVariableName
	/** @var int Live counter. */
	protected int $count = 0;
}
PHP
assert_clean 'class-level directive comments are exempt' \
	"$tmp/class-directive-node.php"

# ---- file-level comments are out of scope: no class body, no members ----
cat > "$tmp/bootstrap-file.php" <<'PHP'
<?php
/**
 * File header.
 *
 * @package Newspack_Nodes
 */

// A file-level note, outside any class.
define( 'X', 1 );
PHP
assert_clean 'file-level comments are not class-body strays' "$tmp/bootstrap-file.php"

# ---- generics: prose with a bare `<` is not a generic type ----
# `n<10` opens no type. Treating it as one ran the collapse to end of line, so
# the gate flagged plain English AND `--fix` ate the spaces after its commas.
cat > "$tmp/class-prose-node.php" <<'PHP'
<?php
class Prose_Node {
	public function f(): int {
		// when n<10, retry, then bail
		return 1;
	}
}
PHP
assert_clean 'prose with a bare < is not a generic type' "$tmp/class-prose-node.php"

# ---- generics: --fix leaves that prose byte-for-byte alone ----
before="$( cat "$tmp/class-prose-node.php" )"
php ./lint-comments.php --fix "$tmp/class-prose-node.php" >/dev/null 2>&1
if [ "$before" = "$( cat "$tmp/class-prose-node.php" )" ]; then
	echo "✓ --fix leaves prose with a bare < untouched"
else
	echo "✗ --fix rewrote prose:"
	diff <( printf '%s\n' "$before" ) "$tmp/class-prose-node.php"
	fail=1
fi

# ---- generics: nested types still collapse at every level ----
cat > "$tmp/class-nested-node.php" <<'PHP'
<?php
class Nested_Node {
	/** @var array<int, array<string, mixed>> Rows. */
	protected array $rows = [];
}
PHP
assert_flags 'a spaced nested generic is flagged' \
	"$tmp/class-nested-node.php" 'space inside a generic type'
php ./lint-comments.php --fix "$tmp/class-nested-node.php" >/dev/null 2>&1
if grep -q 'array<int,array<string,mixed>>' "$tmp/class-nested-node.php"; then
	echo "✓ --fix collapses a nested generic at every level"
else
	echo "✗ --fix left a nested generic uncollapsed:"
	grep '@var' "$tmp/class-nested-node.php"
	fail=1
fi

# ---- generics: prose whose `<` and `>` happen to balance is still prose ----
# `a<b, see c>d` closes depth, so depth alone accepted it as a type. A type
# argument has no internal space; `see c` does.
cat > "$tmp/class-balanced-node.php" <<'PHP'
<?php
class Balanced_Node {
	public function f(): int {
		// for a<b, see c>d, plus the note below
		return 1;
	}
}
PHP
assert_clean 'prose whose angle brackets balance is not a generic' "$tmp/class-balanced-node.php"

# ---- generics: a real type is still caught after an unbalanced `<` ----
# The stray `n<` used to swallow the rest of the line, so the genuine generic
# behind it went ungated.
cat > "$tmp/class-shadowed-node.php" <<'PHP'
<?php
class Shadowed_Node {
	/** @var int If n<10, then array<string, int> applies. */
	protected int $n = 0;
}
PHP
assert_flags 'a real generic behind a stray < is still flagged' \
	"$tmp/class-shadowed-node.php" 'space inside a generic type'
php ./lint-comments.php --fix "$tmp/class-shadowed-node.php" >/dev/null 2>&1
if grep -q 'If n<10, then array<string,int> applies' "$tmp/class-shadowed-node.php"; then
	echo "✓ --fix collapses that generic and leaves the prose alone"
else
	echo "✗ --fix mishandled the shadowed generic:"
	grep '@var' "$tmp/class-shadowed-node.php"
	fail=1
fi

[ "$fail" -eq 0 ] && echo "all comment-gate tests passed"
exit "$fail"

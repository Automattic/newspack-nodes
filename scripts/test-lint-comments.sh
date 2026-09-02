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
root="$( cd .. && pwd )"
trap 'rm -rf "$tmp" "$root"/zzlint-*-config.php' EXIT
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

# ---- docblock: prose after the tag block ----
# A description below `@return` reads as documentation and is nothing of the
# kind: no renderer shows it, and the next editor moves it or drops it. The
# separator is what identifies it — a WRAPPED tag description continues on the
# very next line, so only a blank ` *` followed by non-tag text is this shape.
cat > "$tmp/class-trailer-node.php" <<'PHP'
<?php
class Trailer_Node {
	/**
	 * Does the thing.
	 *
	 * @param int $n A count.
	 * @return int The result.
	 *
	 * A note the author appended after the tags, where it does not belong.
	 */
	public function f( int $n ): int {
		return $n;
	}
}
PHP
assert_flags 'prose after the tag block is flagged (php)' \
	"$tmp/class-trailer-node.php" 'prose after the tag block'

# A tag description that WRAPS is the shape this must not confuse itself with.
cat > "$tmp/class-wrapped-node.php" <<'PHP'
<?php
class Wrapped_Node {
	/**
	 * Does the thing.
	 *
	 * @param int $n A count whose description is long enough to wrap onto a
	 *               second line, and then onto a third line after that.
	 * @return int The result.
	 */
	public function f( int $n ): int {
		return $n;
	}
}
PHP
assert_clean 'a wrapped tag description is not prose after the tags (php)' \
	"$tmp/class-wrapped-node.php"

# A WP-CLI command docblock puts `## OPTIONS` / `## EXAMPLES` BELOW the tags by
# design, and `wp help` renders them. A markdown heading opens that section.
cat > "$tmp/class-wpcli-node.php" <<'PHP'
<?php
class WPCLI_Node {
	/**
	 * Manage the thing.
	 *
	 * @phpstan-import-type Row from Other
	 *
	 * ## EXAMPLES
	 *
	 *     # Show the version
	 *     wp thing version
	 */
	public function f(): void {
	}
}
PHP
assert_clean 'a WP-CLI section below the tags is not stray prose (php)' \
	"$tmp/class-wpcli-node.php"

# ---- docblock: @longform buys nothing, so it is an error there ----
# Docblocks are already exempt from the length gate, so the marker marks
# nothing and the next reader hunts for the rule it is opting out of.
cat > "$tmp/class-tagged-node.php" <<'PHP'
<?php
class Tagged_Node {
	/**
	 * Does the thing.
	 *
	 * @longform The explanation this tag was introducing, which stays; only
	 * the marker in front of it goes.
	 *
	 * @return int The result.
	 */
	public function f(): int {
		return 1;
	}
}
PHP
assert_flags '@longform in a docblock is flagged (php)' \
	"$tmp/class-tagged-node.php" '@longform in a docblock'

# Prose NAMING the tag is not the marker — the gate's own header documents the
# rule, and a docblock that cannot mention it cannot describe it.
cat > "$tmp/class-mentions-node.php" <<'PHP'
<?php
class Mentions_Node {
	/**
	 * Does the thing, and explains that a comment tagged `@longform` is
	 * exempt from the length gate.
	 *
	 * @return int The result.
	 */
	public function f(): int {
		return 1;
	}
}
PHP
assert_clean 'prose naming @longform is not the marker (php)' \
	"$tmp/class-mentions-node.php"

# The tag used to exempt a whole docblock from the prose-after-tags rule, which
# hid real violations. Naming the tag must not buy that exemption back.
cat > "$tmp/class-tagged-trailer-node.php" <<'PHP'
<?php
class Tagged_Trailer_Node {
	/**
	 * Does the thing, and mentions `@longform` in passing.
	 *
	 * @return int The result.
	 *
	 * A note the author appended after the tags, where it does not belong.
	 */
	public function f(): int {
		return 1;
	}
}
PHP
assert_flags 'a docblock naming @longform is still gated on prose after the tags (php)' \
	"$tmp/class-tagged-trailer-node.php" 'prose after the tag block'

# A ONE-LINE docblock is the shape whose only content line is also its opening
# and closing line. Read it as furniture rather than content and the marker
# inside it is checked by nothing, which is where the rule leaks.
cat > "$tmp/class-oneline-tagged-node.php" <<'PHP'
<?php
class Oneline_Tagged_Node {
	/** @longform Live counter, explained at length on a single line. */
	protected int $count = 0;
}
PHP
assert_flags '@longform in a one-line docblock is flagged (php)' \
	"$tmp/class-oneline-tagged-node.php" '@longform in a docblock'

# The same shape carrying a REAL tag is the discriminator: reading that one
# content line must not turn every one-line docblock into a violation.
cat > "$tmp/class-oneline-clean-node.php" <<'PHP'
<?php
class Oneline_Clean_Node {
	/** @return int The result. */
	public function f(): int {
		return 1;
	}
}
PHP
assert_clean 'a one-line docblock carrying a real tag passes (php)' \
	"$tmp/class-oneline-clean-node.php"

# ---- the JS twin must agree, since JSDoc is where this was found ----
command -v node >/dev/null 2>&1 || { echo "✗ node not found on PATH"; exit 2; }

assert_flags_js() {
	local label="$1" file="$2" needle="$3" out
	out="$( node ./lint-comments.mjs "$file" 2>&1 )"
	if [[ "$out" == *"$needle"* ]]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected '$needle'; got:"
		echo "$out"
		fail=1
	fi
}

assert_clean_js() {
	local label="$1" file="$2" out
	out="$( node ./lint-comments.mjs "$file" 2>&1 )"
	if [ -z "$out" ]; then
		echo "✓ $label"
	else
		echo "✗ $label: expected no violations; got:"
		echo "$out"
		fail=1
	fi
}

cat > "$tmp/trailer.js" <<'JS'
/**
 * Does the thing.
 *
 * @param {number} n A count.
 * @return {number} The result.
 *
 * A note the author appended after the tags, where it does not belong.
 */
export function f( n ) {
	return n;
}
JS
assert_flags_js 'prose after the tag block is flagged (js)' \
	"$tmp/trailer.js" 'prose after the tag block'

cat > "$tmp/wrapped.js" <<'JS'
/**
 * Does the thing.
 *
 * @param {Object} [baseline] The result a fresh load starts from. Edges it
 *                            supplies that we no longer declare become
 *                            explicit `disconnect_node` lines.
 * @return {number} The result.
 */
export function f( baseline ) {
	return baseline;
}
JS
assert_clean_js 'a wrapped tag description is not prose after the tags (js)' \
	"$tmp/wrapped.js"

cat > "$tmp/tagged.js" <<'JS'
/**
 * Does the thing.
 *
 * @longform The explanation this tag was introducing, which stays; only the
 * marker in front of it goes.
 *
 * @return {number} The result.
 */
export function f() {
	return 1;
}
JS
assert_flags_js '@longform in a JSDoc block is flagged (js)' \
	"$tmp/tagged.js" '@longform in a docblock'

cat > "$tmp/mentions.js" <<'JS'
/**
 * Does the thing, and explains that a comment tagged `@longform` is exempt
 * from the length gate.
 *
 * @return {number} The result.
 */
export function f() {
	return 1;
}
JS
assert_clean_js 'prose naming @longform is not the marker (js)' \
	"$tmp/mentions.js"

# The opening line is where the JS twin read the tag, so that is where the
# exemption it used to buy has to be proven gone.
cat > "$tmp/tagged-trailer.js" <<'JS'
/** Does the thing, and mentions `@longform` in passing.
 *
 * @return {number} The result.
 *
 * A note the author appended after the tags, where it does not belong.
 */
export function f() {
	return 1;
}
JS
assert_flags_js 'a JSDoc block naming @longform is still gated on prose after the tags (js)' \
	"$tmp/tagged-trailer.js" 'prose after the tag block'

# The JS twin walks lines rather than tokens, so a one-line JSDoc opens and
# closes on the same line and its only content line is that line. Seeding the
# block with anything less leaves the marker inside it checked by nothing.
cat > "$tmp/oneline-tagged.js" <<'JS'
/** @longform Live counter, explained at length on a single line. */
export const count = 0;
JS
assert_flags_js '@longform in a one-line JSDoc block is flagged (js)' \
	"$tmp/oneline-tagged.js" '@longform in a docblock'

# The same shape carrying a REAL tag is the discriminator: reading that one
# content line must not turn every one-line JSDoc into a violation.
cat > "$tmp/oneline-clean.js" <<'JS'
/** @return {number} The result. */
export function f() {
	return 1;
}
JS
assert_clean_js 'a one-line JSDoc block carrying a real tag passes (js)' \
	"$tmp/oneline-clean.js"

# --- Root config files: a ledger shape, not an exemption -------------------
#
# A `<slug>-config.php` at a plugin root is nothing but a returned array of
# deployment overrides, each commented out beside its one-line description.
# The general placement rule rejects every one of those lines (a comment at
# file scope documents no declaration), so the file gets its OWN shape: a run
# of comment lines must land on an entry, commented or live. That still gates
# the file — a floating prose block is a violation — where an exemption would
# have stopped reading it entirely.

cat > "$root/zzlint-demo-config.php" <<'PHP'
<?php
/**
 * Demo configuration — deployment OVERRIDES.
 *
 * @package Demo
 */

\defined( 'ABSPATH' ) || exit;

return [
	// Filesystem root for logs / locks / offsets / IPC dirs.
	// 'base_directory' => '/tmp/newspack-nodes',

	// Sustained SSE streams this HOST allows; each holds a php-fpm child
	// for its whole life. Raise only where the platform grants them.
	// 'sse_max_streams' => 6,

	// A live override sits uncommented beside the rest, and its
	// description still has to land on that entry.
	'on_demand_idle' => 30,
];
PHP
assert_clean 'a root config ledger passes' "$root/zzlint-demo-config.php"

# The rule earns itself only if it still REJECTS prose that documents no key.
cat > "$root/zzlint-prose-config.php" <<'PHP'
<?php
/**
 * Demo configuration — deployment OVERRIDES.
 *
 * @package Demo
 */

\defined( 'ABSPATH' ) || exit;

return [
	// A note about the deployment that names no key at all, and so
	// documents nothing an operator can uncomment.

	// 'base_directory' => '/tmp/newspack-nodes',
];
PHP
assert_flags 'a comment run naming no key is flagged in a config file' \
	"$root/zzlint-prose-config.php" 'documents no config key'

# Length is NOT relaxed: a ledger line still fits the 80 columns.
cat > "$root/zzlint-long-config.php" <<'PHP'
<?php
/**
 * Demo configuration — deployment OVERRIDES.
 *
 * @package Demo
 */

\defined( 'ABSPATH' ) || exit;

return [
	// This description of the key runs well past the eighty column budget the gate enforces.
	// 'base_directory' => '/tmp/newspack-nodes',
];
PHP
assert_flags 'a config-file comment still obeys the column budget' \
	"$root/zzlint-long-config.php" 'exceeds 80 columns'

# ...but the ENTRY it documents is a declaration, and wraps to nothing useful.
cat > "$root/zzlint-longentry-config.php" <<'PHP'
<?php
/**
 * Demo configuration — deployment OVERRIDES.
 *
 * @package Demo
 */

\defined( 'ABSPATH' ) || exit;

return [
	// Object editor link target.
	// 'objecteditor_url' => '/wp-admin/admin.php?page=newspack-pyrobase-object-editor',
];
PHP
assert_clean 'a commented-out ledger ENTRY may exceed the column budget' \
	"$root/zzlint-longentry-config.php"

# ...and so may its body: a commented closure wraps to nothing useful.
cat > "$root/zzlint-longbody-config.php" <<'PHP'
<?php
/**
 * Demo configuration — deployment OVERRIDES.
 *
 * @package Demo
 */

\defined( 'ABSPATH' ) || exit;

return [
	// Interface callback.
	// 'allow_interface' => static function () {
	// 	if ( false !== $app_server && '' !== $app_server && '0' !== $app_server ) {
	// 		return '1';
	// 	}
	// },
];
PHP
assert_clean 'a commented entry BODY may exceed the column budget' \
	"$root/zzlint-longbody-config.php"

# The predicate must not leak onto real code that merely ends in -config.php.
cat > "$tmp/class-config.php" <<'PHP'
<?php
/**
 * Config.
 *
 * @package Demo
 */

class Config {

	// A stray section header that the general rule must still reject.

	/** @return int The value. */
	public function value(): int {
		return 1;
	}
}
PHP
assert_flags 'class-config.php is still judged as code, not a ledger' \
	"$tmp/class-config.php" 'stray'

# Same ledger content, one directory down: judged as code, and rejected.
mkdir -p "$tmp/includes"
cp "$root/zzlint-demo-config.php" "$tmp/includes/zzlint-demo-config.php"
assert_flags 'a -config.php outside the plugin root is not a ledger' \
	"$tmp/includes/zzlint-demo-config.php" 'comment block'

# A commented-out MULTI-LINE array default is the common config shape, and its
# run ends on `// ],` rather than on the key. The run must NAME a key, not land
# on one — ELN's `recommended_log_events` is ~60 lines inside one entry.
cat > "$root/zzlint-array-config.php" <<'PHP'
<?php
/**
 * Demo configuration — deployment OVERRIDES.
 *
 * @package Demo
 */

\defined( 'ABSPATH' ) || exit;

return [
	// Hook names the picker stars; this is a menu, not an instruction.
	// 'recommended_log_events' => [
	//     'init',
	//     'wp_loaded',
	// ],
];
PHP
assert_clean 'a commented multi-line array default passes' \
	"$root/zzlint-array-config.php"

[ "$fail" -eq 0 ] && echo "all comment-gate tests passed"
exit "$fail"

<?php
/**
 * Pre-commit gate: inline comments are ONE line, <= 80 visual columns.
 *
 * Arguments are files or directories — lint-staged passes the staged paths,
 * `npm run lint:php` passes `.` — and `--fix` rewrites what has one correct
 * answer before gating on the rest. `scripts/lint-comments.mjs` is the JS half
 * of the same gate; a rule the two spell differently is a rule neither
 * enforces, so each function with a counterpart names it.
 *
 * LENGTH: a `//`, a `#` and a non-doc slash-star comment are each one line and
 * at most 80 columns, and two adjacent comment lines are a block wanting a
 * docblock instead. Docblocks are exempt from length. An INLINE comment tagged
 * `@longform` (first line) is exempt — the greppable marker for footgun
 * comments whose full length is strictly necessary. Directive comments are
 * exempt too, because splitting one changes what its tool reads.
 *
 * PLACEMENT: outside a function body the only comment allowed is a docblock
 * immediately preceding the declaration it documents, so a docblock whose
 * declaration is gone is itself a violation. A plugin's root config ledger
 * takes the ledger rules instead: a comment run must name the key it
 * describes, and a commented-out entry may run to the declaration's width.
 *
 * DOCBLOCK SHAPE: a docblock is exempt from length already, so opening one of
 * its lines with the `@longform` tag marks nothing and is itself an error;
 * prose naming the tag is fine. A description sitting below the tag block
 * renders nowhere, and is an error for the same reason.
 *
 * GENERICS: a docblock type carries no space after its comma. Write
 * `array<string,mixed>`; a space before `mixed` is the violation. Both parse
 * identically; the editor only highlights the tight one as a single type.
 * `--fix` rewrites them. (The counter-example is described, not written: this
 * file is linted by itself, and `--fix` would collapse it on the next run.)
 *
 * Exit 0 clean; exit 1 with `file:line: message` per violation.
 *
 * @package Newspack_Nodes
 */

/** The column budget every non-exempt comment line fits inside. */
const MAX_COLS  = 80;

/** Columns a tab advances to. The JS twin counts the same stop. */
const TAB_WIDTH = 4;

/**
 * Directories never walked and never linted.
 *
 * Unit tests are exempt from the comment rules by the project's own standard;
 * the rest hold vendored or generated files nobody hand-edits.
 */
const SKIP_DIRS = [ 'tests', 'vendor', 'node_modules', 'build', 'coverage', 'release', '.phpstan', '.git' ];

/**
 * Visual length with tabs expanded to the next TAB_WIDTH stop.
 *
 * Characters, not bytes: an em dash is three bytes, so a byte-wise split makes
 * this gate roughly 3x stricter than the documented 80 columns on exactly the
 * prose it is applied to, while the JS twin, iterating code points, passes the
 * same line. The twins have to agree.
 *
 * @param string $line One source line.
 * @return int Visual columns.
 */
function visual_length( string $line ): int {
	$col = 0;
	foreach ( \mb_str_split( $line ) as $ch ) {
		$col = "\t" === $ch ? ( \intdiv( $col, TAB_WIDTH ) + 1 ) * TAB_WIDTH : $col + 1;
	}
	return $col;
}

/**
 * The balanced `<...>` span starting at `$start`, collapsed, or null when it
 * is not a type at all.
 *
 * Two prose shapes defeat a plain depth counter. `n<10, retry, then bail`
 * never closes, so a collapse trusting the counter runs to end of line and
 * eats the spaces after every later comma. `a<b, see c>d` DOES close, so
 * buffering alone still accepts it. The discriminator is the content: a type
 * argument carries no internal space once its comma-spaces are gone, and
 * `see c` does. A rejected candidate leaves the scan on the very next
 * character rather than skipping the rest of the line, or a stray `<` earlier
 * in a sentence hides a real generic behind it from the gate.
 *
 * @param string $line  One source line.
 * @param int    $start Index of the candidate `<`.
 * @return array{0:int,1:string}|null End index and collapsed text, or null.
 */
function generic_span( string $line, int $start ): ?array {
	$span  = '';
	$depth = 0;
	$len   = \strlen( $line );
	for ( $i = $start; $i < $len; $i++ ) {
		$ch = $line[ $i ];
		if ( '<' === $ch ) {
			++$depth;
		} elseif ( '>' === $ch ) {
			--$depth;
		} elseif ( ',' === $ch ) {
			$span .= ',';
			while ( $i + 1 < $len && ( ' ' === $line[ $i + 1 ] || "\t" === $line[ $i + 1 ] ) ) {
				++$i;
			}
			continue;
		}
		$span .= $ch;
		if ( 0 === $depth ) {
			// A type has no internal whitespace once collapsed; prose does.
			return \preg_match( '/\s/', $span ) ? null : [ $i, $span ];
		}
	}
	return null;
}

/**
 * Drop the spaces after commas inside generic type arguments, at any depth.
 *
 * A candidate `<` has to follow a word character, and `generic_span()` rejects
 * anything unbalanced or holding prose, so `$a < $b` and a lone `<` in a
 * sentence are never rewritten.
 *
 * @param string $line One source line.
 * @return string The line with its generics tightened.
 */
function collapse_generics( string $line ): string {
	$out = '';
	$len = \strlen( $line );
	for ( $i = 0; $i < $len; $i++ ) {
		if ( '<' === $line[ $i ] && $i > 0 && 1 === \preg_match( '/\w/', $line[ $i - 1 ] ) ) {
			$span = generic_span( $line, $i );
			if ( null !== $span ) {
				[ $end, $text ] = $span;
				$out           .= $text;
				$i              = $end;
				continue;
			}
		}
		$out .= $line[ $i ];
	}
	return $out;
}

/**
 * Does this comment open with an annotation a tool reads?
 *
 * A directive addresses phpcs, PHPStan, Psalm, the coverage filter or the
 * translator-comment reader, each of which reads the one line it opens and
 * stops there. Condensing or splitting it changes what that tool sees, so
 * length and placement both step aside.
 *
 * @param string $text Comment text, opener included.
 * @return bool True when the comment opens with a directive tag.
 */
function is_directive( string $text ): bool {
	return 1 === \preg_match( '/^\s*(?:\/\/|#|\/\*)+\s*(?:phpcs:|translators:|eslint-|@var\s|@codeCoverageIgnore|@phpstan-|@codingStandardsIgnore|@psalm-)/', $text );
}

/**
 * Does this text carry the `@longform` opt-out?
 *
 * The tag exempts an inline comment from the length gate. It matches anywhere
 * in the text, and the CALLER picks which text to test — a single-line
 * comment, a block's opening line, a run's first line. That is what keeps the
 * marker on a comment's first line, where a reader meets it before the prose
 * it excuses.
 *
 * @param string $text Comment text, or its first line.
 * @return bool True when the text carries the tag.
 */
function is_longform( string $text ): bool {
	return \str_contains( $text, '@longform' );
}

/**
 * Tokens that may legally follow a docblock inside a class body.
 *
 * A docblock landing on anything else documents nothing, and `stray_comments()`
 * reports it as an orphan. The list covers every member shape: a modifier,
 * `const`, `function`, a trait `use`, an attribute, an enum `case`, a property.
 */
const DECLARATION_TOKENS = [
	\T_PUBLIC, \T_PROTECTED, \T_PRIVATE, \T_STATIC, \T_ABSTRACT, \T_FINAL,
	\T_READONLY, \T_VAR, \T_CONST, \T_FUNCTION, \T_USE, \T_ATTRIBUTE,
	\T_VARIABLE, \T_CASE,
];

/**
 * Comments at class-body level that document no declaration.
 *
 * The only comment allowed outside a function body is a docblock immediately
 * preceding the member it documents. A section header, a `//` note between
 * methods, or a docblock whose method was deleted all describe nothing — and
 * the orphan is worse than noise: it reads as documentation for whatever
 * happens to sit under it. Scope is the CLASS BODY, found by brace depth, so
 * file-level headers are out of scope, and closures and match arms nest deeper
 * and count as function scope. An anonymous class opens a class body of its
 * own, which is why the depths are a stack: closing one has to restore the
 * enclosing class rather than stop the tracking.
 *
 * @param string $source PHP source.
 * @return array<int,string> `line: message` violations.
 */
function stray_comments( string $source ): array {
	$tokens      = \token_get_all( $source );
	$count       = \count( $tokens );
	$depth        = 0;
	$class_depths = [];
	$pending      = false;
	$previous     = null;
	$expr_depth   = 0;
	$hits         = [];

	foreach ( $tokens as $index => $token ) {
		if ( \is_string( $token ) ) {
			if ( '{' === $token ) {
				++$depth;
				if ( $pending ) {
					$class_depths[] = $depth;
					$pending        = false;
				}
			} elseif ( '[' === $token || '(' === $token ) {
				++$expr_depth;
			} elseif ( ']' === $token || ')' === $token ) {
				$expr_depth = \max( 0, $expr_depth - 1 );
			} elseif ( '}' === $token ) {
				// A stack: a closing anon class restores the enclosing one.
				if ( $depth === \end( $class_depths ) ) {
					\array_pop( $class_depths );
				}
				--$depth;
			}
			$previous = $token;
			continue;
		}
		if ( \T_WHITESPACE === $token[0] ) {
			continue;
		}
		if ( \in_array( $token[0], [ \T_CLASS, \T_INTERFACE, \T_TRAIT, \T_ENUM ], true ) ) {
			// `Foo::class` is a constant, not a declaration; it opens no body.
			if ( ! ( \is_array( $previous ) && \T_DOUBLE_COLON === $previous[0] ) ) {
				$pending = true;
			}
			$previous = $token;
			continue;
		}
		if ( \T_CURLY_OPEN === $token[0] || \T_DOLLAR_OPEN_CURLY_BRACES === $token[0] ) {
			++$depth;
			$previous = $token;
			continue;
		}
		if ( \in_array( $token[0], [ \T_COMMENT, \T_DOC_COMMENT ], true ) ) {
			// In an initializer a comment annotates its entry, not the class.
			$class_level = 0 === $expr_depth && [] !== $class_depths
				&& $depth === \end( $class_depths );
			if ( $class_level ) {
				$hits[] = [ $index, $token ];
			}
			continue;
		}
		$previous = $token;
	}

	$violations = [];
	$prev_end   = -10;
	$prev_doc   = true;
	foreach ( $hits as [ $index, $token ] ) {
		$is_doc = \T_DOC_COMMENT === $token[0];
		$line   = $token[2];
		// One report per run of adjacent `//` lines, as the block check does.
		$continuation = ! $is_doc && ! $prev_doc && $line === $prev_end + 1;
		$prev_end     = $line + \substr_count( $token[1], "\n" );
		$prev_doc     = $is_doc;
		if ( $continuation || is_directive( $token[1] ) ) {
			continue;
		}
		// @longform Skip line comments too: a `phpcs:` line between a docblock
		// and its method does not orphan it. A DOCBLOCK is never skipped — a
		// docblock stacked on a docblock is exactly the orphan case.
		$next = null;
		for ( $j = $index + 1; $j < $count; $j++ ) {
			if ( \is_array( $tokens[ $j ] )
				&& \in_array( $tokens[ $j ][0], [ \T_WHITESPACE, \T_COMMENT ], true ) ) {
				continue;
			}
			$next = $tokens[ $j ];
			break;
		}
		if ( $is_doc && \is_array( $next ) && \in_array( $next[0], DECLARATION_TOKENS, true ) ) {
			continue;
		}
		$violations[] = $is_doc
			? "{$line}: orphaned docblock (documents no declaration)"
			: "{$line}: stray comment outside a function (only docblocks on declarations)";
	}
	return $violations;
}

/**
 * A docblock's content lines, stripped of their comment furniture.
 *
 * Both docblock-shape rules read prose, so the opener, the leading `*` and the
 * closer come off first; the line numbers ride along so a violation reports
 * the line it sits on rather than the block's opener. JS twin: `docText` in
 * lint-comments.mjs, whose pairs accumulate into `blockContent`.
 *
 * @param string $doc   The whole T_DOC_COMMENT text.
 * @param int    $start Its first line number.
 * @return list<array{0:int,1:string}> `[ line, text ]` pairs.
 */
function doc_lines( string $doc, int $start ): array {
	$out = [];
	foreach ( \explode( "\n", $doc ) as $offset => $raw ) {
		$text  = \trim( (string) \preg_replace( '{^\s*/?\*+/?\s?}', '', $raw ) );
		$out[] = [ $start + $offset, \trim( (string) \preg_replace( '{\*/$}', '', $text ) ) ];
	}
	return $out;
}

/**
 * The line a docblock carries a `@longform` tag on, or 0.
 *
 * The tag exempts an inline comment from the length gate, and a docblock is
 * exempt already, so inside one it marks nothing while reading as an opt-out
 * the next editor goes hunting for. Only a content line OPENING with it is
 * that marker: prose NAMING the tag stays legal, or this gate's own
 * documentation could not describe the rule it enforces. JS twin:
 * `longformTag` in lint-comments.mjs.
 *
 * @param list<array{0:int,1:string}> $content `[ line, text ]` pairs.
 * @return int The offending line, or 0 when the block carries no tag.
 */
function longform_tag( array $content ): int {
	foreach ( $content as [ $line, $text ] ) {
		if ( \str_starts_with( $text, '@longform' ) ) {
			return $line;
		}
	}
	return 0;
}

/**
 * The line a docblock's description sits BELOW its tags on, or 0.
 *
 * No renderer shows that text, so it reads as documentation while documenting
 * nothing, and the next editor moves it or drops it. The separator identifies
 * it: a WRAPPED tag description continues on the very next line, so only a
 * blank `*` line followed by non-tag text is this shape. JS twin:
 * `proseAfterTags` in lint-comments.mjs.
 *
 * @param list<array{0:int,1:string}> $content `[ line, text ]` pairs.
 * @return int The offending line, or 0 when the block is well-formed.
 */
function prose_after_tags( array $content ): int {
	$seen_tag = false;
	$blank    = false;
	foreach ( $content as [ $line, $text ] ) {
		if ( \str_starts_with( $text, '##' ) ) {
			// WP-CLI parses `## OPTIONS` / `## EXAMPLES` below the tags.
			return 0;
		}
		if ( \str_starts_with( $text, '@' ) ) {
			$seen_tag = true;
			$blank    = false;
		} elseif ( '' === $text ) {
			$blank = true;
		} else {
			if ( $seen_tag && $blank ) {
				return $line;
			}
			$blank = false;
		}
	}
	return 0;
}

/** A `'key' => value,` entry in a config ledger, commented out or live. */
const LEDGER_ENTRY      = "/^\\s*(?:\\/\\/\\s*)?'[a-z0-9_]+'\\s*=>/";

/** The same entry, live only — what a run with no entry of its own lands on. */
const LEDGER_ENTRY_LIVE = "/^\\s*'[a-z0-9_]+'\\s*=>/";

/**
 * Is this a plugin's root configuration ledger?
 *
 * A `<slug>-config.php` is nothing but a returned array of deployment
 * overrides, each commented out beside the description of its key. The block
 * rule reads those description/entry pairs as prose blocks and rejects the
 * whole file, so a ledger is judged by its own shape instead: a run of comment
 * lines must LAND on an entry. That still gates the file — a comment run
 * naming no key is a violation — where exempting it would stop reading it.
 *
 * Anchored to the plugin ROOT, not the basename: `includes/class-config.php`
 * is real code, `tests/*-test-config.php` is a fixture, and neither may take
 * the relaxed placement rule. The root is this script's parent, so a vendored
 * copy resolves its OWN plugin.
 *
 * @param string $file Path being checked.
 * @return bool True when the file is a config ledger.
 */
function is_config_ledger( string $file ): bool {
	if ( 1 !== \preg_match( '/^[a-z0-9-]+-config\.php$/', \basename( $file ) ) ) {
		return false;
	}
	$dir = \realpath( \dirname( $file ) );
	return false !== $dir && $dir === \realpath( \dirname( __DIR__ ) );
}

/**
 * Does a run of comment lines name the key it describes?
 *
 * Either the run CONTAINS a commented-out entry, or the next non-blank source
 * line after it is a live one. Containment rather than landing, because a
 * commented-out multi-line array default ends on `// ],` — the common config
 * shape. A run naming no key at all is a description of nothing, which is what
 * this rule exists to catch.
 *
 * @param int               $start    First line of the run, 1-based.
 * @param int               $len      Lines in the run.
 * @param array<int,string> $comments Comment text keyed by line.
 * @param array<int,string> $lines    Every source line, 0-indexed.
 * @return bool True when the run documents a key.
 */
function ledger_run_names_a_key( int $start, int $len, array $comments, array $lines ): bool {
	for ( $l = $start; $l < $start + $len; $l++ ) {
		if ( 1 === \preg_match( LEDGER_ENTRY, $comments[ $l ] ?? '' ) ) {
			return true;
		}
	}
	for ( $l = $start + $len; $l <= \count( $lines ); $l++ ) {
		$text = \trim( $lines[ $l - 1 ] ?? '' );
		if ( '' === $text ) {
			continue;
		}
		return 1 === \preg_match( LEDGER_ENTRY_LIVE, $text );
	}
	return false;
}

/**
 * Line numbers belonging to a commented-out entry in a config ledger.
 *
 * An entry's continuation lines are code exactly as its first line is: a
 * multi-line array default or a closure body wraps onto lines that no amount
 * of editing turns into prose. The span runs from the `// 'key' =>` line to
 * the one closing it at depth zero.
 *
 * @param array<int,string> $comments Comment text keyed by line.
 * @return array<int,true> The exempt lines, as a set.
 */
function ledger_entry_lines( array $comments ): array {
	$out = []; $open = false; $depth = 0;
	\ksort( $comments );
	foreach ( $comments as $line => $text ) {
		$body = \trim( (string) \preg_replace( '~^\s*//+\s?~', '', $text ) );
		if ( ! $open && 1 !== \preg_match( LEDGER_ENTRY, $text ) ) {
			continue;
		}
		$open         = true;
		$out[ $line ] = true;
		$depth       += \substr_count( $body, '[' ) + \substr_count( $body, '{' )
			- \substr_count( $body, ']' ) - \substr_count( $body, '}' );
		if ( 0 === $depth ) {
			$open = false;
		}
	}
	return $out;
}

/**
 * Every violation in one file.
 *
 * Six passes, in the order they run: the comment-only census, which also
 * reports a multi-line slash-star block; the column budget; generic spacing
 * across every comment and docblock; the two docblock-shape rules; runs of
 * adjacent comment lines; and class-level placement. A config ledger swaps the
 * run rule for its own and lifts the column budget off a commented-out entry,
 * because a key's description and the entry under it ARE the shape the general
 * rules reject.
 *
 * @param string $file Path to check.
 * @return array<int,string> `line: message` violations.
 */
function check_file( string $file ): array {
	$source = \file_get_contents( $file );
	if ( false === $source ) {
		return [ "0: unreadable" ];
	}
	$lines      = \explode( "\n", $source );
	$violations = [];
	$is_ledger  = is_config_ledger( $file );

	// Collect comment-only // or # lines (token-verified) keyed by line number.
	$comment_only = [];
	foreach ( \token_get_all( $source ) as $token ) {
		if ( ! \is_array( $token ) || \T_COMMENT !== $token[0] ) {
			continue;
		}
		[ , $text, $line ] = $token;

		if ( \str_starts_with( $text, '/*' ) ) {
			$first = \strtok( $text, "\n" );
			if ( \substr_count( $text, "\n" ) > 0 && ! is_longform( $first ) && ! is_directive( $first ) ) {
				$violations[] = "{$line}: multi-line /* */ comment (use a docblock, one line, or @longform)";
			} elseif ( 0 === \substr_count( $text, "\n" ) ) {
				$comment_only[ $line ] = $text;
			}
			continue;
		}

		// Comment-only: only whitespace precedes the opener on its line.
		$src_line = $lines[ $line - 1 ] ?? '';
		if ( '' === \trim( \substr( $src_line, 0, \strpos( $src_line, \trim( $text ) ) ?: 0 ) ) ) {
			$comment_only[ $line ] = $text;
		}
	}

	$entry_lines = $is_ledger ? ledger_entry_lines( $comment_only ) : [];

	// Length check on each comment-only line.
	foreach ( $comment_only as $line => $text ) {
		if ( is_longform( $text ) || is_directive( $text ) ) {
			continue;
		}
		// A ledger entry's width is the declaration's, not a sentence's.
		if ( $is_ledger && isset( $entry_lines[ $line ] ) ) {
			continue;
		}
		$src_line = \rtrim( $lines[ $line - 1 ] ?? '', "\r" );
		if ( visual_length( $src_line ) > MAX_COLS ) {
			$violations[] = "{$line}: comment exceeds " . MAX_COLS . ' columns (condense, or tag @longform)';
		}
	}

	// Generics: docblocks carry the types, so this pass sees both kinds.
	foreach ( \token_get_all( $source ) as $token ) {
		if ( ! \is_array( $token ) || ! \in_array( $token[0], [ \T_COMMENT, \T_DOC_COMMENT ], true ) ) {
			continue;
		}
		foreach ( \explode( "\n", $token[1] ) as $offset => $text_line ) {
			if ( collapse_generics( $text_line ) !== $text_line ) {
				$violations[] = ( $token[2] + $offset ) . ': space inside a generic type (array<string,mixed>)';
			}
		}
	}

	// Docblocks: @longform marks nothing here, and a description below the
	// tags documents nothing.
	foreach ( \token_get_all( $source ) as $token ) {
		if ( ! \is_array( $token ) || \T_DOC_COMMENT !== $token[0] ) {
			continue;
		}
		$content = doc_lines( $token[1], $token[2] );
		$tagged  = longform_tag( $content );
		if ( 0 !== $tagged ) {
			$violations[] = "{$tagged}: @longform in a docblock (docblocks are exempt from the length gate; drop the tag)";
		}
		$stray = prose_after_tags( $content );
		if ( 0 !== $stray ) {
			$violations[] = "{$stray}: prose after the tag block (the description goes above the tags)";
		}
	}

	// Block check: >= 2 consecutive comment-only lines, first line not @longform.
	$run_start = 0;
	$run_len   = 0;
	$prev      = 0;
	\ksort( $comment_only );
	$flush     = static function () use ( &$run_start, &$run_len, $comment_only, $lines, $is_ledger, &$violations ): void {
		if ( $run_len < 2 ) {
			return;
		}
		if ( $is_ledger ) {
			if ( ! ledger_run_names_a_key( $run_start, $run_len, $comment_only, $lines ) ) {
				$violations[] = "{$run_start}: {$run_len}-line comment run documents no config key";
			}
			return;
		}
		$non_directive = 0;
		for ( $l = $run_start; $l < $run_start + $run_len; $l++ ) {
			if ( ! is_directive( $comment_only[ $l ] ?? '' ) ) {
				++$non_directive;
			}
		}
		if ( $non_directive >= 2 && ! is_longform( $comment_only[ $run_start ] ?? '' ) ) {
			$violations[] = "{$run_start}: {$run_len}-line comment block (one line, a docblock, or @longform)";
		}
	};
	foreach ( \array_keys( $comment_only ) as $line ) {
		if ( $line === $prev + 1 && $run_len > 0 ) {
			++$run_len;
		} else {
			$flush();
			$run_start = $line;
			$run_len   = 1;
		}
		$prev = $line;
	}
	$flush();

	$violations = \array_merge( $violations, stray_comments( $source ) );

	\sort( $violations, \SORT_NATURAL );
	return $violations;
}

/**
 * Expand a directory argument to the `.php` files under it; pass a file through.
 *
 * The filter around the run loop accepts files alone, so without this a
 * directory argument matches neither branch and is skipped: `lint-comments.php
 * .` — the form `npm run lint:php` uses — exits 0 having checked nothing. The
 * gate then runs green by hand for everyone while lint-staged, which passes
 * explicit paths, fails at commit time on violations nobody can reproduce.
 *
 * @param string $path File or directory.
 * @return list<string> The `.php` files under `$path`, SKIP_DIRS pruned and
 *                      naturally sorted.
 */
function expand_path( string $path ): array {
	if ( \is_file( $path ) ) {
		return [ $path ];
	}
	if ( ! \is_dir( $path ) ) {
		return [];
	}
	$dirs = new \RecursiveDirectoryIterator( $path, \FilesystemIterator::SKIP_DOTS );
	// @longform Prune rather than filter after the walk: descending
	// node_modules only to discard it costs about a second of syscalls, and
	// an unreadable directory throws out of the iterator.
	$pruned = new \RecursiveCallbackFilterIterator(
		$dirs,
		static fn ( \SplFileInfo $entry ): bool =>
			$entry->isDir()
				? ! \in_array( $entry->getFilename(), SKIP_DIRS, true )
				: 'php' === \strtolower( $entry->getExtension() )
	);
	$out = [];
	foreach ( new \RecursiveIteratorIterator( $pruned ) as $entry ) {
		$out[] = (string) \preg_replace( '#^\./#', '', $entry->getPathname() );
	}
	\sort( $out, \SORT_NATURAL );
	return $out;
}

/**
 * Rewrite one file's comment and docblock generics in place.
 *
 * Only comment and docblock tokens are rewritten, so a `<` in a string or an
 * expression is never reached.
 *
 * @param string $file Path to rewrite.
 * @return bool True when the file was rewritten.
 */
function fix_generics( string $file ): bool {
	$source = \file_get_contents( $file );
	if ( false === $source ) {
		return false;
	}
	$out = '';
	foreach ( \token_get_all( $source ) as $token ) {
		if ( \is_array( $token ) && \in_array( $token[0], [ \T_COMMENT, \T_DOC_COMMENT ], true ) ) {
			$out .= \implode( "\n", \array_map( 'collapse_generics', \explode( "\n", $token[1] ) ) );
			continue;
		}
		$out .= \is_array( $token ) ? $token[1] : $token;
	}
	if ( $out === $source ) {
		return false;
	}
	\file_put_contents( $file, $out );
	return true;
}

$targets = [];
$fix     = false;
foreach ( \array_slice( $argv, 1 ) as $argument ) {
	if ( '--fix' === $argument ) {
		$fix = true;
		continue;
	}
	$targets = \array_merge( $targets, expand_path( $argument ) );
}

$failed = false;
foreach ( $targets as $file ) {
	if ( ! \str_ends_with( $file, '.php' ) || ! \is_file( $file ) ) {
		continue;
	}
	// Also filter explicit paths: lint-staged passes files, not a directory.
	if ( 1 === \preg_match( '#(^|/)(' . \implode( '|', \array_map( '\preg_quote', SKIP_DIRS ) ) . ')/#', $file ) ) {
		continue;
	}
	// --fix still gates; a fixer exiting 0 would no-op pre-commit.
	if ( $fix && fix_generics( $file ) ) {
		\fwrite( \STDOUT, "fixed generics: {$file}\n" );
	}
	foreach ( check_file( $file ) as $violation ) {
		\fwrite( \STDERR, "{$file}:{$violation}\n" );
		$failed = true;
	}
}
exit( $failed ? 1 : 0 );

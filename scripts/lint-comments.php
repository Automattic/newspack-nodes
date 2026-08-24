<?php
/**
 * Pre-commit gate: inline comments are ONE line, <= 80 visual columns.
 *
 * Two rules. LENGTH: `//`, `#`, and non-doc slash-star comments in the staged
 * files lint-staged passes as argv are one line and <= 80 columns; docblocks
 * are exempt from length. PLACEMENT: outside a function body the only comment
 * allowed is a docblock immediately preceding the declaration it documents, so
 * a docblock whose declaration is gone is itself a violation. An INLINE
 * comment tagged `@longform` (first line) is exempt — the greppable marker for
 * footgun comments whose full length is strictly necessary. A docblock is
 * exempt already, so opening one of its lines with that tag marks nothing and
 * is itself an error; prose naming the tag is fine. Directive comments
 * (`phpcs:`, `translators:`, `eslint-`) are exempt: they cannot be split.
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

const MAX_COLS  = 80;
const TAB_WIDTH = 4;

/** Directories never linted: unit tests are exempt by owner's rule, the rest are not ours. */
const SKIP_DIRS = [ 'tests', 'vendor', 'node_modules', 'build', 'coverage', 'release', '.phpstan', '.git' ];

/**
 * Visual length with tabs expanded to the next TAB_WIDTH stop.
 *
 * Characters, not bytes: `str_split` counted an em dash as 3, so the PHP gate
 * was roughly 3x stricter than the documented 80 columns on exactly the prose
 * it is applied to — and the JS twin, iterating code points, passed the same
 * line. The twins have to agree.
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
 * Two prose shapes defeat a plain depth counter, and both reached the tree.
 * `n<10, retry, then bail` never closes, so the collapse ran to end of line
 * and ate the spaces after every later comma. `a<b, see c>d` DOES close, so
 * buffering alone still accepted it. The discriminator is the content: a type
 * argument carries no internal space once its comma-spaces are gone, and
 * `see c` does. Rejecting a candidate must also backtrack rather than skip the
 * rest of the line, or a stray `<` earlier in a sentence hides a real generic
 * behind it from the gate.
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

function is_directive( string $text ): bool {
	return 1 === \preg_match( '/^\s*(?:\/\/|#|\/\*)+\s*(?:phpcs:|translators:|eslint-|@var\s|@codeCoverageIgnore|@phpstan-|@codingStandardsIgnore|@psalm-)/', $text );
}

function is_longform( string $text ): bool {
	return \str_contains( $text, '@longform' );
}

/** Tokens that may legally follow a docblock inside a class body. */
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
 * file-level headers are out of scope and closures, anonymous classes and match
 * arms all nest deeper and count as function scope.
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
 * @param string $doc   The whole T_DOC_COMMENT text.
 * @param int    $start Its first line number.
 * @return list<array{0:int,1:string}> `[ line, text ]` pairs. JS twin:
 *                                     `blockContent` in lint-comments.mjs.
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

/**
 * Every violation in one file.
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

		// Comment-only = nothing but whitespace precedes it on its line.
		$src_line = $lines[ $line - 1 ] ?? '';
		if ( '' === \trim( \substr( $src_line, 0, \strpos( $src_line, \trim( $text ) ) ?: 0 ) ) ) {
			$comment_only[ $line ] = $text;
		}
	}

	// Length check on each comment-only line.
	foreach ( $comment_only as $line => $text ) {
		if ( is_longform( $text ) || is_directive( $text ) ) {
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
	$flush = static function () use ( &$run_start, &$run_len, $comment_only, &$violations ): void {
		if ( $run_len < 2 ) {
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
 * Without this a directory argument matched neither branch of the filter
 * below and was silently skipped, so `lint-comments.php .` — the form
 * `npm run lint:php` uses — exited 0 having checked nothing. The gate ran
 * green by hand for everyone while lint-staged, which passes explicit paths,
 * failed at commit time on violations nobody could reproduce.
 *
 * @param string $path File or directory.
 * @return list<string>
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
 * Rewrite one file's docblock generics in place, leaving code untouched.
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

<?php
/**
 * Pre-commit gate: inline comments are ONE line, <= 80 visual columns.
 *
 * Checks `//`, `#`, and non-doc slash-star comments in the staged files
 * lint-staged passes as argv. Docblocks are exempt. A comment tagged
 * `@longform` (first line) is exempt — the greppable marker for footgun
 * comments whose full length is strictly necessary. Directive comments
 * (`phpcs:`, `translators:`, `eslint-`) are exempt: they cannot be split.
 *
 * Exit 0 clean; exit 1 with `file:line: message` per violation.
 *
 * @package Newspack_Nodes
 */

const MAX_COLS  = 80;
const TAB_WIDTH = 4;

/** Visual length with tabs expanded to the next TAB_WIDTH stop. */
function visual_length( string $line ): int {
	$col = 0;
	foreach ( \str_split( $line ) as $ch ) {
		$col = "\t" === $ch ? ( \intdiv( $col, TAB_WIDTH ) + 1 ) * TAB_WIDTH : $col + 1;
	}
	return $col;
}

function is_directive( string $text ): bool {
	return 1 === \preg_match( '/^\s*(?:\/\/|#|\/\*)+\s*(?:phpcs:|translators:|eslint-|@var\s|@codeCoverageIgnore|@phpstan-|@codingStandardsIgnore|@psalm-)/', $text );
}

function is_longform( string $text ): bool {
	return \str_contains( $text, '@longform' );
}

/**
 * @return array<int, string> `line: message` violations for one file.
 */
function check_file( string $path ): array {
	$source = \file_get_contents( $path );
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

	\sort( $violations, \SORT_NATURAL );
	return $violations;
}

$failed = false;
foreach ( \array_slice( $argv, 1 ) as $path ) {
	if ( ! \str_ends_with( $path, '.php' ) || ! \is_file( $path ) ) {
		continue;
	}
	// Unit tests are exempt (owner's rule), as are vendored trees.
	if ( 1 === \preg_match( '#(^|/)(tests|vendor|node_modules)/#', $path ) ) {
		continue;
	}
	foreach ( check_file( $path ) as $violation ) {
		\fwrite( \STDERR, "{$path}:{$violation}\n" );
		$failed = true;
	}
}
exit( $failed ? 1 : 0 );

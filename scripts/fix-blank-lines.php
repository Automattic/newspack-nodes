<?php
/**
 * fix-blank-lines.php — collapse runs of blank lines to one.
 *
 * A hole of blank lines is what's left where something used to be.
 * `reorder-node-methods.php` moves method spans under a whole-file byte
 * histogram, which by design preserves every newline, so a method moved out of
 * a class leaves its blank lines behind. Deleting a comment block does the same.
 *
 * @longform Only T_WHITESPACE tokens are rewritten, never the raw text. Blank
 * lines inside a heredoc, nowdoc or quoted string are DATA — collapsing them
 * changes what the program prints — and a line-oriented pass cannot tell the
 * difference. Those bodies are other token types, so they are never reached.
 *
 * Usage:
 *   php fix-blank-lines.php [--check] <path> [...]
 *
 * Default rewrites in place; `--check` only reports and exits 1 on a violation.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

/** Blank lines allowed in a row. Two newlines in a row IS one blank line. */
const MAX_BLANK_LINES = 1;

/**
 * Collapse over-long newline runs in a PHP source string.
 *
 * @param string $source Whole file contents.
 * @return array{0:string,1:list<int>} Rewritten source, and the lines a run started on.
 */
function collapse_blank_lines( string $source ): array {
	// @longform The trailing ([ \t]*) is the NEXT line's indentation — a
	// whitespace token runs from the end of one line to the first code on the
	// next — so it is captured and put back. Eating it unindents that line.
	$run    = '/\n(?:[ \t]*\n){' . ( MAX_BLANK_LINES + 1 ) . ',}([ \t]*)/';
	$out    = '';
	$hits   = [];
	$line   = 1;

	foreach ( \token_get_all( $source ) as $token ) {
		$text = \is_array( $token ) ? $token[1] : $token;
		if ( \is_array( $token ) && \T_WHITESPACE === $token[0] && \preg_match( $run, $text ) ) {
			$hits[] = $line;
			$text   = \preg_replace( $run, "\n\n\$1", $text );
		}
		$out  .= $text;
		$line += \substr_count( \is_array( $token ) ? $token[1] : $token, "\n" );
	}

	return [ $out, $hits ];
}

/** @return list<string> Every .php file under a path. */
function php_files( string $path ): array {
	if ( \is_file( $path ) ) {
		return [ $path ];
	}
	if ( ! \is_dir( $path ) ) {
		return [];
	}
	$skip  = [ 'node_modules', 'vendor', 'build', 'release', '.phpstan', '.git' ];
	$files = [];
	$walk  = new RecursiveIteratorIterator(
		new RecursiveCallbackFilterIterator(
			new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ),
			static fn ( SplFileInfo $f ): bool => ! \in_array( $f->getFilename(), $skip, true )
		)
	);
	foreach ( $walk as $file ) {
		if ( $file->isFile() && 'php' === $file->getExtension() ) {
			$files[] = $file->getPathname();
		}
	}
	return $files;
}

$args  = \array_slice( $argv, 1 );
$check = \in_array( '--check', $args, true );
$paths = \array_values( \array_filter( $args, static fn ( string $a ): bool => '--' !== \substr( $a, 0, 2 ) ) );

if ( [] === $paths ) {
	\fwrite( \STDERR, "usage: php fix-blank-lines.php [--check] <path> [...]\n" );
	exit( 2 );
}

$violations = 0;
foreach ( $paths as $path ) {
	foreach ( php_files( $path ) as $file ) {
		$source = (string) \file_get_contents( $file );
		[ $fixed, $hits ] = collapse_blank_lines( $source );
		if ( [] === $hits || $fixed === $source ) {
			continue;
		}
		$violations += \count( $hits );
		foreach ( $hits as $at ) {
			\fwrite( \STDERR, "{$file}:{$at}: more than " . MAX_BLANK_LINES . " blank line in a row\n" );
		}
		if ( ! $check ) {
			\file_put_contents( $file, $fixed );
		}
	}
}

exit( $violations > 0 && $check ? 1 : 0 );

<?php
/**
 * PHPCS sniff: an ABSPATH guard is the one line `\defined( 'ABSPATH' ) || exit;`.
 *
 * A guard is an `if` whose condition is `! defined( 'ABSPATH' )`, the backslash
 * optional, and whose body, braced or not, is a bare `exit`, `exit()`, `die` or
 * `die()`. An `if` defining ABSPATH, or carrying an `else`, is not a guard.
 * phpcbf rewrites a guard into the one line, keeping the backslash the source
 * wrote, unless a comment sits inside it, which the rewrite would delete.
 *
 * Every plugin's phpcs.xml.dist references this file by path. PHPCS takes the
 * sniff code, `Newspack.WP.AbspathGuard`, from the namespace, and needs only a
 * `Sniffs/` directory in the path. `scripts/test-abspath-guard-sniff.sh` in
 * newspack-nodes holds it to its fixtures.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack\Sniffs\WP;

use PHP_CodeSniffer\Files\File;
use PHP_CodeSniffer\Sniffs\Sniff;
use PHP_CodeSniffer\Util\Tokens;

/**
 * Reports, and rewrites, every ABSPATH guard not written as one line.
 */
final class AbspathGuardSniff implements Sniff {

	/** The condition's words, the leading backslash dropped. */
	private const CONDITION = [ '!', 'defined', '(', "'ABSPATH'", ')' ];

	/** The bodies a guard may hold, `die` read as `exit`. */
	private const BODIES = [ [ 'exit', ';' ], [ 'exit', '(', ')', ';' ] ];

	/** The guard's one-line form, after the optional backslash. */
	private const ONE_LINE = "defined( 'ABSPATH' ) || exit;";

	/**
	 * Report the `if` at `$if` when it is an ABSPATH guard.
	 *
	 * @param File $file The file being scanned.
	 * @param int  $if   The `if` token's position.
	 * @return void
	 */
	public function process( File $file, $if ) {
		$tokens = $file->getTokens();
		if ( ! isset( $tokens[ $if ]['parenthesis_opener'], $tokens[ $if ]['parenthesis_closer'] ) ) {
			return;
		}

		$condition = $this->words( $file, $tokens[ $if ]['parenthesis_opener'] + 1, $tokens[ $if ]['parenthesis_closer'] - 1 );
		$qualified = '\\' === ( $condition[1] ?? null );
		if ( $qualified ) {
			\array_splice( $condition, 1, 1 );
		}
		if ( self::CONDITION !== $condition ) {
			return;
		}

		$end = $this->body_end( $file, $if );
		if ( null === $end ) {
			return;
		}

		$next = $file->findNext( Tokens::$emptyTokens, $end + 1, null, true );
		if ( false !== $next && \in_array( $tokens[ $next ]['code'], [ \T_ELSE, \T_ELSEIF ], true ) ) {
			return;
		}

		$message = 'Use the one-line ABSPATH guard: %s';
		$data    = [ ( $qualified ? '\\' : '' ) . self::ONE_LINE ];
		if ( false !== $file->findNext( Tokens::$commentTokens, $if, $end + 1 ) ) {
			$file->addError( $message, $if, 'NotOneLine', $data );
			return;
		}

		if ( $file->addFixableError( $message, $if, 'NotOneLine', $data ) ) {
			$file->fixer->beginChangeset();
			$file->fixer->replaceToken( $if, $data[0] );
			for ( $i = $if + 1; $i <= $end; $i++ ) {
				$file->fixer->replaceToken( $i, '' );
			}
			$file->fixer->endChangeset();
		}
	}

	/**
	 * The last token of a guard's body, or null when the body is not a bare exit.
	 *
	 * @param File $file The file being scanned.
	 * @param int  $if   The `if` token's position.
	 * @return int|null The closing brace, or the braceless body's semicolon.
	 */
	private function body_end( File $file, int $if ): ?int {
		$tokens = $file->getTokens();
		if ( isset( $tokens[ $if ]['scope_opener'] ) ) {
			$opener = $tokens[ $if ]['scope_opener'];
			if ( \T_OPEN_CURLY_BRACKET !== $tokens[ $opener ]['code'] ) {
				return null;
			}
			$end  = $tokens[ $if ]['scope_closer'];
			$body = $this->words( $file, $opener + 1, $end - 1 );
		} else {
			$start = $tokens[ $if ]['parenthesis_closer'] + 1;
			$end   = $file->findNext( \T_SEMICOLON, $start );
			if ( false === $end ) {
				return null;
			}
			$body = $this->words( $file, $start, $end );
		}

		return \in_array( $body, self::BODIES, true ) ? $end : null;
	}

	/**
	 * The non-empty tokens from `$start` to `$end`, inclusive, as words.
	 *
	 * A function name and `exit`/`die` fold to lower case, `die` to `exit`, and
	 * a double-quoted string to single quotes; every other token keeps its text.
	 *
	 * @param File $file  The file being scanned.
	 * @param int  $start First position.
	 * @param int  $end   Last position.
	 * @return list<string>
	 */
	private function words( File $file, int $start, int $end ): array {
		$tokens = $file->getTokens();
		$words  = [];
		for ( $i = $start; $i <= $end; $i++ ) {
			$token = $tokens[ $i ];
			if ( isset( Tokens::$emptyTokens[ $token['code'] ] ) ) {
				continue;
			}
			$words[] = match ( $token['code'] ) {
				\T_EXIT => 'exit',
				\T_STRING => \strtolower( $token['content'] ),
				\T_CONSTANT_ENCAPSED_STRING => "'" . \substr( $token['content'], 1, -1 ) . "'",
				default => $token['content'],
			};
		}
		return $words;
	}

	/**
	 * The tokens this sniff listens for.
	 *
	 * @return list<int|string>
	 */
	public function register(): array {
		return [ \T_IF ];
	}
}

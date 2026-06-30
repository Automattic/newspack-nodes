<?php
/**
 * Structural invariant: every Message is created via Message::new_message() or
 * Message::unpacked() — never hand-rolled.
 *
 * Messages are positional arrays (ADR-2), so the language can't give us a
 * private constructor to funnel creation through. This test is the next best
 * thing: it scans the source for the two hand-construction idioms and fails on
 * any outside the factory itself —
 *   - a KEYED literal `[ Message::TYPE => ... ]` (only new_message() may do this), and
 *   - a POSITIONAL literal `[ Message::TM_*, <timestamp>, ... ]` (a TM_ type
 *     constant followed by a numeric/clock second field — the shape that drifts
 *     in, e.g. the HookNodeTest literal this guard was written after).
 *
 * Reach: it catches the idioms that actually occur. It CANNOT catch a fully
 * bare-number literal with no `Message::` token (`[ 1, 1.7e9, '', … ]`) — a
 * regex can't distinguish that from any 7-element array without false-positives.
 * So it's a lint-as-a-test, not a type guarantee: it makes the common violation
 * fail CI instead of sliding through review.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;

class MessageConstructionInvariantTest extends TestCase {

	/**
	 * A `[ Message::TM_*, <number|Core::$now|microtime|time()> ` literal — a message, not a type-set
	 * (a type-set's 2nd element is another `TM_*`) and not a bitmask (`TM_A | TM_B` has no comma).
	 * The optional `\?(\w+\)*` allows a namespace-qualified `\Newspack_Nodes\Message::`.
	 */
	private const POSITIONAL = '/\[\s*\\\\?(?:\w+\\\\)*Message::TM_[A-Z_]+\s*,\s*(?:[0-9.]|Core::\$now|\\\\?microtime|\\\\?time\()/';

	/** `Message::TYPE =>` — the keyed construction idiom (indexing `$m[ Message::TYPE ]` has no `=>`). */
	private const KEYED = '/(?:\\\\?(?:\w+\\\\)*)?Message::TYPE\s*=>/';

	public function test_messages_are_only_built_by_the_factories(): void {
		$root       = \dirname( __DIR__, 2 );
		$violations = [];
		foreach ( $this->php_sources( $root ) as $file ) {
			$base = \basename( $file );
			// The factory itself and this guard (which quotes the patterns) are exempt.
			if ( 'class-message.php' === $base || 'MessageConstructionInvariantTest.php' === $base ) {
				continue;
			}
			$src = (string) \file_get_contents( $file );
			$rel = \substr( $file, \strlen( $root ) + 1 );
			if ( \preg_match( self::KEYED, $src ) ) {
				$violations[] = "{$rel}: keyed [ Message::TYPE => … ] message literal — use Message::new_message()";
			}
			if ( \preg_match( self::POSITIONAL, $src ) ) {
				$violations[] = "{$rel}: positional [ Message::TM_*, <ts>, … ] message literal — use Message::new_message()";
			}
		}
		$this->assertSame(
			[],
			$violations,
			"Build every Message via Message::new_message() / Message::unpacked(), never a hand-rolled literal:\n" . \implode( "\n", $violations )
		);
	}

	/**
	 * Every production .php under includes/. Tests are deliberately NOT scanned:
	 * a round-trip / wire-format fixture (e.g. `pack( [ TM_BYTESTREAM, 1, … ] )`)
	 * legitimately builds the exact positional frame it asserts on — the literal
	 * IS the test. The invariant this guard enforces is runtime consistency: at
	 * run time, every Message originates from the factory.
	 *
	 * @return iterable<string>
	 */
	private function php_sources( string $root ): iterable {
		$base = "{$root}/includes";
		if ( ! \is_dir( $base ) ) {
			return;
		}
		$it = new \RecursiveIteratorIterator(
			new \RecursiveDirectoryIterator( $base, \FilesystemIterator::SKIP_DOTS )
		);
		foreach ( $it as $f ) {
			if ( $f->isFile() && 'php' === \strtolower( $f->getExtension() ) ) {
				yield $f->getPathname();
			}
		}
	}
}

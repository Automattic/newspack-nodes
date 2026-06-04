<?php
/**
 * Hook_Node filter-mode behavior.
 *
 * Messages are positional list-arrays, so in filter mode Hook_Node only adopts
 * an apply_filters return that is still a list. A non-list / non-array return is
 * dropped (the prior message is forwarded) rather than passed to
 * sink->fill( array &$message ) where it would fatal — but that drop must be
 * surfaced via a rate-limited warning, not swallowed silently.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Hook_Node;
use Newspack_Nodes\Tests\TestCase;

class HookNodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	public function test_filter_returning_non_list_is_dropped_with_a_warning(): void {
		$node = new Hook_Node();
		$node->name( 'hooky' );
		$node->arguments( 'eln_hook_nonlist 1' ); // filter mode on.

		// A misbehaving filter that returns a non-list (associative) array.
		\add_filter( 'eln_hook_nonlist', static fn( $msg ) => [ 'not' => 'a list' ] );

		$warned = '';
		Core::set_stderr_handler( function ( $m ) use ( &$warned ) { $warned .= $m; } );

		$message = [ 1, 0.0, 'from', '', 0, '', 'payload' ];
		$node->fill( $message );

		$this->assertSame( [ 1, 0.0, 'from', '', 0, '', 'payload' ], $message, 'A non-list filter return must not be adopted.' );
		$this->assertStringContainsString( 'eln_hook_nonlist', $warned, 'Dropping a non-list filter return must emit a warning, not swallow it silently.' );
	}

	public function test_filter_returning_a_list_is_adopted(): void {
		$node = new Hook_Node();
		$node->name( 'hooky' );
		$node->arguments( 'eln_hook_list 1' );

		\add_filter( 'eln_hook_list', static fn( $msg ) => [ 2, 0.0, 'x', '', 0, '', 'new' ] );

		$message = [ 1, 0.0, 'from', '', 0, '', 'payload' ];
		$node->fill( $message );

		$this->assertSame( [ 2, 0.0, 'x', '', 0, '', 'new' ], $message, 'A valid list filter return must be adopted.' );
	}
}

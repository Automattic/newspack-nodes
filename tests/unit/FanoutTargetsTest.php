<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Fanout_Targets;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Echo_Node;

/**
 * The liveness of a fan-out target list lives in ONE place. Tee and Tap carried
 * byte-identical copies of the prune; the minters that sign per spoke need the
 * same thing, and a target list that is read without being pruned rots — a
 * removed spoke stays in the list forever and gets commands minted for it.
 */
#[CoversTrait( Fanout_Targets::class )]
class FanoutTargetsTest extends TestCase {

	private function fanout(): object {
		return new class() extends Node {
			use Fanout_Targets;

			public function __construct() {
				parent::__construct();
				$this->target = [];
			}

			/** @return list<string> */
			public function targets(): array {
				return $this->live_targets();
			}

			public function path( string $target, string $remainder ): string {
				return $this->target_path( $target, $remainder );
			}
		};
	}

	/** Node::connect_node() replaces; a fan-out must accumulate. */
	/**
	 * `target()` is the normalizing accessor: it accepts the scalar form Node's
	 * base API and the TSL round-trip both hand it, and always reads back a list.
	 */
	public function test_target_accepts_a_scalar_and_reads_back_a_list(): void {
		$node = $this->fanout();

		$this->assertSame( [ 'alpha' ], $node->target( 'alpha' ) );
		$this->assertSame( [ 'alpha' ], $node->target() );
	}

	public function test_target_accepts_a_list_and_reindexes_it(): void {
		$node = $this->fanout();

		$this->assertSame(
			[ 'alpha', 'beta' ],
			$node->target( [ 3 => 'alpha', 7 => 'beta' ] )
		);
	}

	public function test_setting_an_empty_target_clears_the_list(): void {
		$node = $this->fanout();
		$node->target( 'alpha' );

		$this->assertSame( [], $node->target( '' ) );
	}

	/** A node constructed with the base class's scalar target still reads as a list. */
	public function test_a_scalar_target_field_normalizes_on_read(): void {
		$node = new class() extends Node {
			use Fanout_Targets;
		};
		$node->name( 'scalar-target' );
		$node->connect_node( 'alpha' );

		$this->assertSame( [ 'alpha' ], $node->target() );
	}

	public function test_connect_node_accumulates_instead_of_replacing(): void {
		$node = $this->fanout();
		( new Echo_Node() )->name( 'spoke-alpha' );
		( new Echo_Node() )->name( 'spoke-beta' );

		$node->connect_node( 'spoke-alpha' );
		$node->connect_node( 'spoke-beta' );

		$this->assertSame( [ 'spoke-alpha', 'spoke-beta' ], $node->targets() );
	}

	public function test_connect_node_ignores_a_duplicate(): void {
		$node = $this->fanout();
		( new Echo_Node() )->name( 'spoke-alpha' );

		$node->connect_node( 'spoke-alpha' );
		$node->connect_node( 'spoke-alpha' );

		$this->assertSame( [ 'spoke-alpha' ], $node->targets() );
	}

	/** Reading the list is what prunes it — the property the whole trait exists for. */
	public function test_reading_the_targets_prunes_a_vanished_node(): void {
		$node  = $this->fanout();
		$alive = new Echo_Node();
		$alive->name( 'spoke-alpha' );
		$doomed = new Echo_Node();
		$doomed->name( 'spoke-beta' );
		$node->connect_node( 'spoke-alpha' );
		$node->connect_node( 'spoke-beta' );

		$doomed->remove_node();

		$this->assertSame( [ 'spoke-alpha' ], $node->targets() );
		$this->assertSame( [ 'spoke-alpha' ], $node->targets(), 'the prune is written back, not recomputed' );
	}

	/** A path-shaped target survives while its HEAD resolves; Router peels the rest. */
	public function test_a_path_shaped_target_survives_on_a_live_head(): void {
		$node = $this->fanout();
		( new Echo_Node() )->name( 'spoke-alpha' );
		$node->connect_node( 'spoke-alpha/settings' );

		$this->assertSame( [ 'spoke-alpha/settings' ], $node->targets() );
	}

	/**
	 * Prepend the target and keep the rest of the path: Router peels the head, so
	 * the remainder routes on past this hop. Tee and every minter that fans out
	 * address the same way; only Tap hard-addresses, which is why the dispatch
	 * loops stay separate.
	 */
	public function test_target_path_prepends_the_target_and_keeps_the_remainder(): void {
		$node = $this->fanout();

		$this->assertSame( 'spoke-alpha/settings', $node->path( 'spoke-alpha', 'settings' ) );
	}

	public function test_target_path_is_the_bare_target_when_nothing_remains(): void {
		$node = $this->fanout();

		$this->assertSame( 'spoke-alpha', $node->path( 'spoke-alpha', '' ) );
	}

	public function test_disconnect_node_removes_only_the_named_target(): void {
		$node = $this->fanout();
		( new Echo_Node() )->name( 'spoke-alpha' );
		( new Echo_Node() )->name( 'spoke-beta' );
		$node->connect_node( 'spoke-alpha' );
		$node->connect_node( 'spoke-beta' );

		$node->disconnect_node( 'spoke-alpha' );

		$this->assertSame( [ 'spoke-beta' ], $node->targets() );
	}
}

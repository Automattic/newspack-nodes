<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Fanout_Targets;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tee_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;

/** A plain node standing for whatever members a test hands it. */
final class Stands_For_Node extends Node {
	/** @var list<Node> */
	public array $stands_for = [];

	/** @return list<Node> */
	public function members(): ?array {
		return $this->stands_for;
	}
}

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

			/** @return list<string> */
			public function extras(): array {
				return $this->extra_targets();
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

	protected function tearDown(): void {
		Vault::get_instance()->reset_cache();
		parent::tearDown();
	}

	/**
	 * A `Vault_Group` target stands for its members: `live_targets()` expands
	 * it into one entry per member, `target()` keeps reporting the group by
	 * name (the stored list still holds it), and `display_targets()` shows
	 * both the group edge and every member edge fanned through it.
	 */
	public function test_live_targets_expands_a_vault_group_into_its_members(): void {
		$this->seed_vault_servers(
			[
				'tw0'  => [ 'url' => 'https://tw0.example', 'group' => 'tw-edge' ],
				'tw9'  => [ 'url' => 'https://tw9.example', 'group' => 'tw-edge' ],
				'lone' => [ 'url' => 'https://lone.example' ],
				'aux'  => [ 'url' => 'https://aux.example', 'group' => 'llm' ],
			]
		);
		( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'egress', 'Echo', 'tw-edge' );
		( new Echo_Node() )->name( 'plain-3' );

		$node = $this->fanout();
		$node->connect_node( 'egress' );
		$node->connect_node( 'plain-3' );

		$this->assertSame( [ 'egress:tw0', 'egress:tw9', 'plain-3' ], $node->targets() );
		$this->assertSame( [ 'egress', 'plain-3' ], $node->target() );
		$this->assertSame(
			[ 'egress', 'plain-3', 'egress:tw0', 'egress:tw9' ],
			$node->display_targets()
		);
	}

	/**
	 * A `Vault_Group` whose group has zero members fans out to nothing and
	 * declares no extra destination — an empty group is a moment with nowhere
	 * to fan out, not an error — while its own name still stands in `target()`.
	 */
	public function test_a_vault_group_with_no_members_contributes_nothing(): void {
		$this->seed_vault_servers(
			[
				'tw0'  => [ 'url' => 'https://tw0.example', 'group' => 'tw-edge' ],
				'tw9'  => [ 'url' => 'https://tw9.example', 'group' => 'tw-edge' ],
				'lone' => [ 'url' => 'https://lone.example' ],
				'aux'  => [ 'url' => 'https://aux.example', 'group' => 'llm' ],
			]
		);
		$group = ( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'egress', 'Echo', 'ghost' );
		$this->assertSame( [], $group->members() );

		$node = $this->fanout();
		$node->connect_node( 'egress' );

		$this->assertSame( [], $node->targets() );
		$this->assertSame( [ 'egress' ], $node->target() );
		$this->assertSame( [], $node->extras() );
	}

	/**
	 * Expansion asks the target node, not its class: any node whose
	 * `members()` answers a list is delivered as those members, exactly as a
	 * group is, while a node answering null stands for itself.
	 */
	public function test_a_tee_expands_any_node_that_stands_for_members(): void {
		$bundle = new Stands_For_Node();
		$bundle->name( 'bundle-5' );
		foreach ( [ 'member-a', 'member-b' ] as $name ) {
			$member = new Echo_Node();
			$member->name( $name );
			$bundle->stands_for[] = $member;
		}
		( new Echo_Node() )->name( 'plain-3' );
		$sink = new Capture_Sink_Node();
		$tee  = new Tee_Node();
		$tee->sink( $sink );
		$tee->connect_node( 'bundle-5' );
		$tee->connect_node( 'plain-3' );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'tail-7';
		$tee->fill( $message );

		$this->assertSame(
			[ 'member-a/tail-7', 'member-b/tail-7', 'plain-3/tail-7' ],
			\array_map( static fn ( array $m ): string => $m[ Message::TO ], $sink->captured )
		);
		$this->assertNull( ( new Echo_Node() )->members() );
	}
}

<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * A node that builds its own hidden helpers owes them four things: a
 * collision pre-check on every `{name}:{suffix}` slot, a rename cascade, a
 * sink cascade and a teardown cascade. Node performs that quartet for every
 * slot `publish_sibling()` fills, its own `:config` interpreter included, so
 * publishing is the whole of what a patron has to remember.
 */
#[CoversClass( Node::class )]
class OwnedSiblingsTest extends TestCase {

	/**
	 * A patron that PUBLISHES an `escort` from its constructor, before it has a
	 * name — the shape a sibling builder actually has. The suffix is
	 * deliberately unlike any real one (source, offsetlog, deadletter, flight,
	 * auto-tuner) so nothing here can pass on a production node's behaviour. The
	 * escort owns a `deputy` of its own, so the tree is two deep and a cascade
	 * that stops at the patron's own slots is visible from here.
	 */
	private function patron(): object {
		return new class() extends Node {
			public ?Node $escort  = null;
			public ?Node $courier = null;

			public function __construct() {
				parent::__construct();
				$this->escort = new class() extends Node {
					public ?Node $deputy = null;

					public function __construct() {
						parent::__construct();
						$this->deputy = new Echo_Node();
						$this->deputy->patron( $this );
						$this->publish_sibling( 'deputy', $this->deputy );
					}
				};
				$this->escort->patron( $this );
				$this->publish_sibling( 'escort', $this->escort );
			}

			/** @api Publish a finished sibling into a slot. */
			public function publish( string $suffix, Node $sibling ): void {
				$this->publish_sibling( $suffix, $sibling );
			}

			/** @api Drop a slot and the sibling occupying it. */
			public function retract( string $suffix ): void {
				$this->retract_sibling( $suffix );
			}
		};
	}

	public function test_publishing_a_sibling_names_it_from_the_slot_it_goes_into(): void {
		$patron  = $this->patron();
		$patron->name( 'quartermaster' );
		$courier = new Echo_Node();

		$patron->publish( 'courier', $courier );
		$patron->courier = $courier;

		$this->assertSame( 'quartermaster:courier', $courier->name() );
		$this->assertSame( $courier, Core::node( 'quartermaster:courier' ) );
	}

	/**
	 * Retracting is the exact inverse of publishing: publishing owns the slot
	 * AND the name, so retracting owes both. A slot dropped while the registry
	 * keeps the sibling's name leaves `{name}:{suffix}` registered against a
	 * node nothing owns, and the next occupant of that slot is refused for the
	 * life of the process.
	 */
	public function test_retracting_a_sibling_tears_it_down_and_frees_its_name(): void {
		$patron = $this->patron();
		$patron->name( 'quartermaster' );
		$escort = $patron->escort;

		$patron->retract( 'escort' );

		$this->assertSame( '', $escort->name() );
		$this->assertNull( Core::node( 'quartermaster:escort' ) );
		$this->assertNull( Core::node( 'quartermaster:escort:deputy' ) );
	}

	public function test_a_retracted_slot_accepts_a_fresh_occupant(): void {
		$patron = $this->patron();
		$patron->name( 'quartermaster' );
		$patron->retract( 'escort' );
		$relief = new Echo_Node();

		$patron->publish( 'escort', $relief );

		$this->assertSame( $relief, Core::node( 'quartermaster:escort' ) );
	}

	/**
	 * The refusal can come from a GRANDCHILD — the relief carries a deputy of
	 * its own, and the naming recurses. The slot is left EMPTY, so the
	 * caller's idempotency guard rebuilds rather than serving a sibling whose
	 * own sibling never got a name.
	 */
	public function test_a_refused_publish_leaves_the_slot_empty(): void {
		$squatter = new Echo_Node();
		$squatter->name( 'quartermaster:courier:deputy' );
		$patron   = $this->patron();
		$patron->name( 'quartermaster' );
		$relief   = new class() extends Node {
			public function __construct() {
				parent::__construct();
				$deputy = new Echo_Node();
				$deputy->patron( $this );
				$this->publish_sibling( 'deputy', $deputy );
			}
		};

		try {
			$patron->publish( 'courier', $relief );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'node name collision: quartermaster:courier:deputy already registered', $e->getMessage() );
			$this->assertSame( '', $relief->name() );
			$patron->publish( 'courier', new Echo_Node() );
			$this->assertInstanceOf( Echo_Node::class, Core::node( 'quartermaster:courier' ), 'the emptied slot must accept a rebuild' );
			return;
		}
		$this->fail( 'expected the relief deputy to collide with the squatter' );
	}

	public function test_publishing_under_an_unnamed_patron_leaves_the_sibling_unnamed(): void {
		$patron  = $this->patron();
		$courier = new Echo_Node();

		$patron->publish( 'courier', $courier );

		$this->assertSame( '', $courier->name() );
	}

	/**
	 * Pins the refusal itself, and the two things it leaves behind: the
	 * incumbent keeps the slot and its name, and the refused sibling stays
	 * unnamed and unregistered. The patron here is UNNAMED at the publish, the
	 * path a naming collision cannot cover.
	 */
	public function test_publishing_into_an_occupied_slot_is_refused(): void {
		$patron  = $this->patron();
		$courier = new Echo_Node();
		$patron->publish( 'courier', $courier );
		$relief = new Echo_Node();

		try {
			$patron->publish( 'courier', $relief );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'sibling slot occupied: courier', $e->getMessage() );
			$patron->name( 'bosun' );
			$this->assertSame( $courier, Core::node( 'bosun:courier' ), 'the incumbent keeps the slot' );
			$this->assertSame( '', $relief->name(), 'the refused sibling stays unnamed and unregistered' );
			return;
		}
		$this->fail( 'expected the occupied courier slot to be refused' );
	}

	public function test_publishing_into_a_squatted_slot_names_nothing(): void {
		$squatter = new Echo_Node();
		$squatter->name( 'quartermaster:courier' );
		$patron   = $this->patron();
		$patron->name( 'quartermaster' );
		$courier  = new Echo_Node();

		try {
			$patron->publish( 'courier', $courier );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'node name collision: quartermaster:courier already registered', $e->getMessage() );
			$this->assertSame( '', $courier->name() );
			return;
		}
		$this->fail( 'expected the squatted slot to be refused' );
	}

	/**
	 * Publishing IS declaring: the escort goes into its slot from a constructor,
	 * before the patron has a name, and the patron taking one is what names it.
	 */
	public function test_naming_a_patron_registers_each_published_sibling_under_its_suffix(): void {
		$patron = $this->patron();

		$patron->name( 'quartermaster' );

		$this->assertSame( 'quartermaster:escort', $patron->escort->name() );
		$this->assertSame( $patron->escort, Core::node( 'quartermaster:escort' ) );
	}

	public function test_renaming_moves_every_sibling_and_drops_the_old_slot(): void {
		$patron = $this->patron();
		$patron->name( 'quartermaster' );

		$patron->name( 'bosun' );

		$this->assertNull( Core::node( 'quartermaster:escort' ) );
		$this->assertSame( $patron->escort, Core::node( 'bosun:escort' ) );
	}

	public function test_a_squatted_sibling_slot_blocks_the_rename(): void {
		$squatter = new Echo_Node();
		$squatter->name( 'quartermaster:escort' );
		$patron = $this->patron();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'node name collision: quartermaster:escort already registered' );
		$patron->name( 'quartermaster' );
	}

	/**
	 * The pre-check has to reach a sibling's OWN siblings, because the rename
	 * cascade does: `set_sibling_names()` calls `$sibling->name()`, which runs
	 * that sibling's check over slots the patron never looked at. A squat on
	 * `{new}:escort:deputy` therefore throws from the middle of the cascade,
	 * after the patron has already vacated its old name and taken the new one
	 * — leaving it answering to a name whose sibling slots resolve to nothing.
	 */
	public function test_a_squatted_grandchild_slot_blocks_the_rename(): void {
		$patron = $this->patron();
		$patron->name( 'quartermaster' );
		$squatter = new Echo_Node();
		$squatter->name( 'bosun:escort:deputy' );

		try {
			$patron->name( 'bosun' );
			$this->fail( 'expected the grandchild collision to throw' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'bosun:escort:deputy', $e->getMessage() );
		}

		$this->assertSame( 'quartermaster', $patron->name() );
		$this->assertSame( $patron, Core::node( 'quartermaster' ) );
		$this->assertSame( $patron->escort, Core::node( 'quartermaster:escort' ) );
		$this->assertNull( Core::node( 'bosun' ) );
		$this->assertNull( Core::node( 'bosun:escort' ) );
	}

	public function test_a_blocked_rename_leaves_the_patron_unregistered(): void {
		$squatter = new Echo_Node();
		$squatter->name( 'quartermaster:escort' );
		$patron = $this->patron();

		try {
			$patron->name( 'quartermaster' );
		} catch ( \RuntimeException $e ) {
			$this->assertNull( Core::node( 'quartermaster' ) );
			return;
		}
		$this->fail( 'expected the sibling collision to throw' );
	}

	public function test_setting_the_sink_propagates_to_every_built_sibling(): void {
		$patron = $this->patron();
		$sink   = new Echo_Node();

		$patron->sink( $sink );

		$this->assertSame( $sink, $patron->escort->sink() );
		$this->assertSame( $sink, $patron->sink() );
	}

	public function test_reading_the_sink_does_not_rewire_siblings(): void {
		$patron = $this->patron();
		$sink   = new Echo_Node();
		$patron->sink( $sink );
		$other = new Echo_Node();
		$patron->escort->sink( $other );

		$this->assertSame( $sink, $patron->sink() );
		$this->assertSame( $other, $patron->escort->sink() );
	}

	public function test_remove_node_unregisters_every_sibling(): void {
		$patron = $this->patron();
		$patron->name( 'quartermaster' );

		$patron->remove_node();

		$this->assertNull( Core::node( 'quartermaster' ) );
		$this->assertNull( Core::node( 'quartermaster:escort' ) );
	}

	/**
	 * The cascade is a full remove_node(), not a bare unregister: teardown also
	 * clears the sibling's own name, sink and patron, so nothing downstream
	 * keeps emitting through a node the topology has dropped.
	 */
	public function test_remove_node_fully_tears_each_sibling_down(): void {
		$patron = $this->patron();
		$patron->sink( new Echo_Node() );
		$patron->name( 'quartermaster' );
		$escort = $patron->escort;

		$patron->remove_node();

		$this->assertSame( '', $escort->name() );
		$this->assertNull( $escort->sink() );
		$this->assertNull( $escort->patron() );
	}

	/**
	 * A patron with a sibling of its own still gets the base's `:config`
	 * interpreter cascaded, because publishing is what puts either into the
	 * map. Both halves move together on a rename; neither old slot survives.
	 */
	public function test_a_published_sibling_and_the_config_interpreter_both_follow_a_rename(): void {
		$patron = new class() extends Node {
			use \Newspack_Nodes\Schema_Reflection;

			public ?Node $escort = null;

			public function __construct() {
				parent::__construct();
				$this->auto_wire_interpreter();
				$this->escort = new Echo_Node();
				$this->escort->patron( $this );
				$this->publish_sibling( 'escort', $this->escort );
			}

			public function config(): ?Node {
				return $this->interpreter;
			}

			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'commands' => [
						[ 'name' => 'weigh', 'handler' => static fn ( $interpreter, string $args ): string => "ok\n" ],
					],
				] );
			}
		};
		$patron->name( 'harbourmaster' );

		$patron->name( 'lamplighter' );

		$this->assertSame( $patron->escort, Core::node( 'lamplighter:escort' ) );
		$this->assertSame( $patron->config(), Core::node( 'lamplighter:config' ) );
		$this->assertNull( Core::node( 'harbourmaster:escort' ) );
		$this->assertNull( Core::node( 'harbourmaster:config' ) );
	}

	/**
	 * The interpreter is published in the CONSTRUCTOR, so insertion order would
	 * rank it first. It ranks last instead: derived scaffolding is the least
	 * useful collision to report, and the pre-check walks siblings in order.
	 */
	public function test_the_config_interpreter_ranks_last_among_siblings(): void {
		$config_squatter = new Echo_Node();
		$config_squatter->name( 'harbourmaster:config' );
		$escort_squatter = new Echo_Node();
		$escort_squatter->name( 'harbourmaster:escort' );
		$patron = $this->wired_patron();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'node name collision: harbourmaster:escort already registered' );
		$patron->name( 'harbourmaster' );
	}

	/**
	 * `config_line()` addresses the interpreter's ACTUAL slot. A patron that
	 * re-keys it through `sibling_suffix()` gets its verbs addressed there;
	 * spelling `{name}:config` would emit a line routable to nothing.
	 */
	public function test_config_line_addresses_the_slot_the_interpreter_was_keyed_into(): void {
		$patron = $this->wired_patron( 'helm' );
		$patron->name( 'harbourmaster' );

		$this->assertSame( "command_node harbourmaster:helm weigh anchor\n", $patron->line() );
		$this->assertSame( 'harbourmaster:helm', Core::node( 'harbourmaster:helm' )?->name() );
		$this->assertNull( Core::node( 'harbourmaster:config' ) );
	}

	/**
	 * A patron that wires its interpreter and publishes an escort, both from the
	 * constructor. $config_suffix re-keys the interpreter's slot.
	 */
	private function wired_patron( string $config_suffix = 'config' ): object {
		return new class( $config_suffix ) extends Node {
			use \Newspack_Nodes\Schema_Reflection;

			public ?Node $escort = null;

			public function __construct( private string $config_suffix = 'config' ) {
				parent::__construct();
				$this->auto_wire_interpreter();
				$this->escort = new Echo_Node();
				$this->escort->patron( $this );
				$this->publish_sibling( 'escort', $this->escort );
			}

			/** @api Emit one verb line addressed at the interpreter's slot. */
			public function line(): string {
				return $this->config_line( 'weigh', 'anchor' );
			}

			protected function sibling_suffix( string $kind ): string {
				return 'config' === $kind ? $this->config_suffix : $kind;
			}

			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'commands' => [
						[ 'name' => 'weigh', 'handler' => static fn ( $interpreter, string $args ): string => "ok\n" ],
					],
				] );
			}
		};
	}
}

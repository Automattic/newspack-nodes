<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Fanout_Targets;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\HTTP_Out_Node;
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

			/** @param list<string> $arguments */
			public function send( string $to, string $verb, array $arguments ): void {
				$this->send_signed( $to, $verb, $arguments );
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
		HTTP_Out_Node::$curl_dispatch = null;
		Command_Auth::forget_session( 'tw0' );
		Command_Auth::forget_session( 'tw1' );
		Command_Auth::forget_session( 'tw9' );
		Command_Auth::forget_session( 'lone' );
		Command_Auth::forget_session( 'aux' );
		Vault::get_instance()->reset_cache();
		parent::tearDown();
	}

	/** Distinct per spoke, so a signature under the wrong key is visible. */
	private const HANDLE_A = 'a1a1b2b2c3c3d4d4e5e5f6f6a7a7b8b8';
	private const HANDLE_B = 'f9f9e8e8d7d7c6c6b5b5a4a4f3f3e2e2';

	/** Count the `/auth` handshakes an egress starts, without any real HTTP. */
	private function count_handshakes( int &$posts ): void {
		HTTP_Out_Node::$curl_dispatch = static function ( array $opts ) use ( &$posts ): \CurlHandle {
			++$posts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** A named sender sinking into a capture, targeted at the given spokes. */
	private function sender( Capture_Sink_Node $sink, string ...$targets ): object {
		$node = $this->fanout();
		$node->name( 'probe-7' );
		$node->sink( $sink );
		foreach ( $targets as $target ) {
			$node->connect_node( $target );
		}
		return $node;
	}

	/**
	 * One command per live spoke, minted by this node and signed under that
	 * spoke's own key: a signature verifies only where it was minted for, so
	 * the mint cannot happen once and be re-addressed afterwards.
	 */
	public function test_send_signed_mints_one_signed_command_per_live_target(): void {
		$this->egress( 'spokes:tw0', 'tw0' );
		$this->egress( 'spokes:tw1', 'tw1' );
		Command_Auth::remember_session( 'tw0', self::HANDLE_A, 'key-tw0-4242' );
		Command_Auth::remember_session( 'tw1', self::HANDLE_B, 'key-tw1-9999' );
		$sink = new Capture_Sink_Node();

		$this->sender( $sink, 'spokes:tw0', 'spokes:tw1' )->send( 'inbox-3', 'reindex', [ 'alpha-5', '--depth=2' ] );

		$this->assertCount( 2, $sink->captured );
		foreach ( [ 0 => [ 'spokes:tw0/inbox-3', self::HANDLE_A ], 1 => [ 'spokes:tw1/inbox-3', self::HANDLE_B ] ] as $i => [ $to, $handle ] ) {
			$out = $sink->captured[ $i ];
			$this->assertSame( Message::TM_COMMAND, $out[ Message::TYPE ] );
			$this->assertSame( 'probe-7', $out[ Message::FROM ] );
			$this->assertSame( $to, $out[ Message::TO ] );
			$this->assertSame( 'reindex', $out[ Message::VALUE ]['name'] );
			$this->assertSame( [ 'alpha-5', '--depth=2' ], $out[ Message::VALUE ]['arguments'] );
			$this->assertSame( $handle, $out[ Message::VALUE ]['auth']['handle'] );
		}
	}

	/** With nowhere to deliver, nothing is minted and no handshake is asked for. */
	public function test_send_signed_without_a_sink_mints_nothing_and_asks_no_handshake(): void {
		$this->seed_vault_servers( [ 'tw0' => [ 'url' => 'https://tw0.example' ] ] );
		$this->egress( 'spokes:tw0', 'tw0' );
		$posts = 0;
		$this->count_handshakes( $posts );
		$node = $this->fanout();
		$node->name( 'probe-7' );
		$node->connect_node( 'spokes:tw0' );

		$node->send( 'inbox-3', 'reindex', [] );

		$this->assertSame( 0, $posts );
	}

	/**
	 * A spoke with no session is skipped AND asked to handshake, or both sides
	 * sit still. The skip is logged only past 30 seconds of uptime, while a
	 * session still being established is not worth a line.
	 */
	public function test_a_sessionless_spoke_is_skipped_asked_to_handshake_and_logged_after_30s(): void {
		$this->seed_vault_servers(
			[
				'tw0' => [ 'url' => 'https://tw0.example' ],
				'tw1' => [ 'url' => 'https://tw1.example' ],
			]
		);
		$this->egress( 'spokes:tw0', 'tw0' );
		$this->egress( 'spokes:tw1', 'tw1' );
		Command_Auth::remember_session( 'tw0', self::HANDLE_A, 'key-tw0-4242' );
		$posts = 0;
		$this->count_handshakes( $posts );
		$lines = [];
		Core::set_stderr_handler(
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);
		$sink = new Capture_Sink_Node();
		$node = $this->sender( $sink, 'spokes:tw0', 'spokes:tw1' );

		Core::$init_time = 5000.0;
		Core::$now       = 5029.0;
		$node->send( 'inbox-3', 'reindex', [] );
		$quiet = $lines;
		Core::$now = 5031.0;
		$node->send( 'inbox-3', 'reindex', [] );

		$this->assertSame( [], $quiet, 'the first 30 seconds stay quiet' );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( 'no session for spokes:tw1; skipping', $lines[0] );
		$this->assertGreaterThan( 0, $posts, 'the skip must ask for a handshake' );
		$this->assertSame(
			[ 'spokes:tw0/inbox-3', 'spokes:tw0/inbox-3' ],
			\array_map( static fn ( array $m ): string => $m[ Message::TO ], $sink->captured ),
			'the sessionless spoke gets nothing; the other still ships'
		);
	}

	/**
	 * A target may be a PATH, alive while its head is, so the egress is
	 * resolved by that head: a full-path lookup finds nothing, the handshake
	 * never starts, and the deadlock the skip exists to break survives.
	 */
	public function test_a_path_form_target_without_a_session_still_kicks_the_handshake(): void {
		$this->seed_vault_servers( [ 'tw0' => [ 'url' => 'https://tw0.example' ] ] );
		$this->egress( 'spokes:tw0', 'tw0' );
		$posts = 0;
		$this->count_handshakes( $posts );
		$sink = new Capture_Sink_Node();

		$this->sender( $sink, 'spokes:tw0/inbox-3' )->send( 'inbox-3', 'reindex', [] );

		$this->assertSame( [], $sink->captured, 'no session: nothing may be minted' );
		$this->assertGreaterThan( 0, $posts, 'the skip path must ask for a handshake' );
	}

	/**
	 * A `Vault_Group` target signs one command per member, each under that
	 * member's own key. The non-members carry sessions too, so a stray the
	 * expansion leaked would ship its own command rather than be skipped.
	 */
	public function test_send_signed_signs_one_command_per_vault_group_member(): void {
		$this->seed_vault_servers(
			[
				'tw0'  => [ 'url' => 'https://tw0.example', 'group' => 'tw-edge' ],
				'tw9'  => [ 'url' => 'https://tw9.example', 'group' => 'tw-edge' ],
				'lone' => [ 'url' => 'https://lone.example' ],
				'aux'  => [ 'url' => 'https://aux.example', 'group' => 'llm' ],
			]
		);
		( new Command_Interpreter_Node() )->make_node( 'Vault_Group', 'egress', 'HTTP_Out', 'tw-edge' );
		Command_Auth::remember_session( 'tw0', self::HANDLE_A, 'key-tw0-4242' );
		Command_Auth::remember_session( 'tw9', self::HANDLE_B, 'key-tw9-9999' );
		Command_Auth::remember_session( 'lone', 'c4c4d5d5e6e6f7f7a8a8b9b9c0c0d1d1', 'key-lone-1111' );
		Command_Auth::remember_session( 'aux', 'e2e2f3f3a4a4b5b5c6c6d7d7e8e8f9f9', 'key-aux-2222' );
		$sink = new Capture_Sink_Node();

		$this->sender( $sink, 'egress' )->send( 'inbox-3', 'reindex', [] );

		$this->assertSame(
			[ [ 'egress:tw0/inbox-3', self::HANDLE_A ], [ 'egress:tw9/inbox-3', self::HANDLE_B ] ],
			\array_map( static fn ( array $m ): array => [ $m[ Message::TO ], $m[ Message::VALUE ]['auth']['handle'] ], $sink->captured )
		);
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

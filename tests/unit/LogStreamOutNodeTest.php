<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Rest\Log_Stream_Out_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * The `/log/stream` SSE controller: mirrors `/messages/stream` exactly on the
 * wire, but resolves subscriptions against the fixed `Log_Sources` registry
 * and opens `Tail` readers instead of Consumers. The subscribe param carries
 * registry NAMES only — a caller can never supply a path.
 */
#[CoversClass( Log_Stream_Out_Node::class )]
class LogStreamOutNodeTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'log-stream-' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		parent::tearDown();
	}

	// ── open_subscription: file-mode sources ───────────────────────────────

	public function test_known_name_opens_one_file_mode_tail_stamped_by_registry_name(): void {
		$path = "{$this->tmp}/gyro-live.log";
		\file_put_contents( $path, "abcdefgh\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];

		$tails = ( new Log_Stream_Out_Node() )->open_subscription( 'gyro', null );

		$this->assertCount( 1, $tails );
		$tail = $tails[0];
		$this->assertInstanceOf( Tail_Node::class, $tail );
		$this->assertSame( 'gyro', $tail->stamped_as() );
		$this->assertSame( Tail_Node::MODE_FILE, $this->read_private( $tail, 'source_mode' ) );
		$this->assertSame( $path, $this->read_private( $tail, 'source_file' ) );
		// Ephemeral SSE reader: the browser holds the cursor, no durable state.
		$this->assertSame( '', $this->read_private( $tail, 'offsetlog_dir' ) );
		$this->assertSame( '', $this->read_private( $tail, 'deadletter_dir' ) );
		// No position → live tail from END (9 bytes, distinct from offset 0).
		$this->assertSame( 9, $this->read_private( $tail, 'cursor_offset' ) );
	}

	public function test_reopening_with_the_advertised_resume_id_does_not_replay(): void {
		$path = "{$this->tmp}/php-error.log";
		\file_put_contents( $path, "line-one\nline-two\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		// First connect: tail from END, and advertise where that is.
		$first = ( new Log_Stream_Out_Node() )->open_subscription( 'php', null )[0];
		$token = 'php=' . $first->cursor_position();

		// The reopen carries it as Last-Event-ID and sends no positions param.
		$ctrl     = new Log_Stream_Out_Node();
		$resumed  = self::positions_from_token( $token );
		$reopened = $ctrl->open_subscription( 'php', $resumed )[0];
		$cap      = new Capture_Sink_Node();
		$reopened->sink( $cap );
		for ( $i = 0; $i < 5; $i++ ) {
			$reopened->poll();
		}

		$this->assertSame( [], $cap->captured, "the reopen must not replay; token was {$token}" );
	}

	public function test_reopening_mid_line_resumes_live_instead_of_replaying_the_file(): void {
		// A live log sampled mid-write: 'end' is the raw file SIZE, which is not
		// a line boundary. First connect never validates it, but the reopen
		// does — and a failed boundary check returns 0, i.e. the whole file.
		$path = "{$this->tmp}/php-error.log";
		\file_put_contents( $path, "line-one\nline-two\npartial-no-newline" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$first = ( new Log_Stream_Out_Node() )->open_subscription( 'php', null )[0];
		$token = 'php=' . $first->cursor_position();

		$ctrl     = new Log_Stream_Out_Node();
		$reopened = $ctrl->open_subscription( 'php', self::positions_from_token( $token ) )[0];
		$cap      = new Capture_Sink_Node();
		$reopened->sink( $cap );
		// The first tick only fills the buffer; pump until it stops producing.
		for ( $i = 0; $i < 5; $i++ ) {
			$reopened->poll();
		}

		$this->assertSame( [], $cap->captured, "a live tail must never replay the file; token was {$token}" );
	}

	public function test_a_reopened_tail_advertises_its_pending_seek_not_zero(): void {
		// THE replay loop: on a reopen the position lands in file_seek_candidate
		// and cursor_offset stays 0 until the first poll opens the handle. A
		// cursor_position() reading cursor_offset therefore advertises `:0`, the
		// client echoes `:0`, and every reopen after that replays the whole file.
		$path = "{$this->tmp}/php-error.log";
		\file_put_contents( $path, "line-one\nline-two\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$ctrl = new Log_Stream_Out_Node();
		$tail = $ctrl->open_subscription( 'php', self::positions_from_token( 'php=:9' ) )[0];

		// The CLIENT named no generation, and its offset belongs to whichever
		// one it was reading — pairing it with the live inode would pass the
		// resume check and mis-seek into a rotated-in file.
		$this->assertSame( ':9', $tail->cursor_position() );
	}

	/**
	 * The round trip the viewer actually performs: connect at EOF, hang up,
	 * lines arrive in the gap, reconnect echoing the advertised token. Those
	 * lines must be DELIVERED — tail-seeking again is what leaves the view on
	 * "Waiting for log lines..." while the offset climbs.
	 */
	public function test_reconnect_with_the_advertised_token_delivers_the_gap(): void {
		$path = "{$this->tmp}/php-error.log";
		\file_put_contents( $path, "before-one\nbefore-two\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		// Connect at EOF and take the id the `connected` envelope would carry.
		$first = ( new Log_Stream_Out_Node() )->open_subscription( 'php', null )[0];
		$token = 'php=' . $first->cursor_position();

		// The gap: lines written while nothing is connected.
		\file_put_contents( $path, "gap-one\ngap-two\n", \FILE_APPEND );

		$ctrl     = new Log_Stream_Out_Node();
		$reopened = $ctrl->open_subscription( 'php', self::positions_from_token( $token ) )[0];
		$cap      = new Capture_Sink_Node();
		$reopened->sink( $cap );
		for ( $i = 0; $i < 12; $i++ ) {
			$reopened->poll();
		}

		$this->assertSame(
			[ "gap-one\n", "gap-two\n" ],
			\array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured ),
			"token was {$token}"
		);
	}

	public function test_cursor_position_names_the_generation_before_the_first_poll(): void {
		$path = "{$this->tmp}/gyro-live.log";
		\file_put_contents( $path, "abcdefgh\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];

		$tail = ( new Log_Stream_Out_Node() )->open_subscription( 'gyro', null )[0];

		// The inode reaches cursor_segment only when the handle opens on the
		// first poll, and a stream that seeks to EOF and hangs up never polls
		// — so ask the path. An unnamed generation is indistinguishable from a
		// foreign one and reads the whole file back on every reconnect.
		$this->assertSame( \fileinode( $path ) . ':9', $tail->cursor_position() );
	}

	public function test_position_keyed_by_name_seeds_the_file_mode_resume_candidate(): void {
		$path = "{$this->tmp}/gyro-live.log";
		\file_put_contents( $path, "abcdefgh\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];

		$tails = ( new Log_Stream_Out_Node() )->open_subscription(
			'gyro',
			[ 'gyro' => [ 'segment' => 4242, 'offset' => 77 ] ]
		);

		// File mode defers an array seek until the handle opens on first poll.
		$this->assertSame(
			[
				'inode'  => 4242,
				'offset' => 77,
			],
			$this->read_private( $tails[0], 'file_seek_candidate' )
		);
	}

	// ── open_subscription: topology-inferred segmented sources ─────────────

	public function test_topology_source_opens_a_segmented_tail_with_the_resolved_path(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$dir = "{$this->tmp}/topologies";
		\mkdir( $dir, 0755, true );
		\file_put_contents(
			"{$dir}/lstream.tsl",
			"var num_partitions = 2\n"
			. "make_node Log beacon:log <config:logs_dir>/beacon-7e.p<partition>/beacon-7e 1 2 7\n"
		);
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lstream' ] ] );

		$tails = ( new Log_Stream_Out_Node() )->open_subscription(
			'beacon-7e.p1',
			[ 'beacon-7e.p1' => [ 'segment' => 3, 'offset' => 9 ] ]
		);

		$this->assertCount( 1, $tails );
		$tail = $tails[0];
		$this->assertSame( Tail_Node::MODE_SEGMENTED, $this->read_private( $tail, 'source_mode' ) );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p1/beacon-7e", $this->read_private( $tail, 'source_file' ) );
		$this->assertSame( 'beacon-7e.p1', $tail->stamped_as() );
		// Segmented seek seeds the cursor directly (Consumer's array branch).
		$this->assertSame( 3, $this->read_private( $tail, 'cursor_segment' ) );
		$this->assertSame( 9, $this->read_private( $tail, 'cursor_offset' ) );
	}

	// ── open_subscription: names only, never paths ─────────────────────────

	public function test_unknown_name_throws_a_teaching_error_listing_known_sources(): void {
		$path = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];
		$ctrl = new Log_Stream_Out_Node();

		try {
			$ctrl->open_subscription( 'nope-1189', null );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'unknown log source', $e->getMessage() );
			$this->assertStringContainsString( 'gyro', $e->getMessage(), 'the error teaches the known names' );
		}
	}

	public function test_a_caller_supplied_path_is_never_a_registry_name(): void {
		$path = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];
		$ctrl = new Log_Stream_Out_Node();

		foreach ( [ '/etc/passwd', '../../etc/passwd', 'gyro/../gyro' ] as $evil ) {
			try {
				$ctrl->open_subscription( $evil, null );
				$this->fail( "expected InvalidArgumentException for {$evil}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertStringContainsString( 'unknown log source', $e->getMessage() );
			}
		}
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_log_stream_get_route(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new Log_Stream_Out_Node() )->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/log/stream', $route['route'] );
		$this->assertSame( 'GET', $route['args']['methods'] );
		$this->assertTrue( $route['args']['args']['subscribe']['required'] );
		$this->assertFalse( $route['args']['args']['positions']['required'] );
		$this->assertIsCallable( $route['args']['callback'] );
		$this->assertIsCallable( $route['args']['permission_callback'] );
	}
	/**
	 * A client's own token → the `positions` shape it sends. The server no
	 * longer decodes `Last-Event-ID`; `positions` is the only resume input.
	 *
	 * @param string $token `dir=segment:offset` pairs, comma-separated.
	 * @return array<string,array{segment?:int,offset:int}>|null
	 */
	private static function positions_from_token( string $token ): ?array {
		$out = [];
		foreach ( \explode( ',', $token ) as $pair ) {
			if ( ! \preg_match( '/^(\S+)=(\d*):(\d+)$/D', $pair, $m ) ) {
				continue;
			}
			$position = [ 'offset' => (int) $m[3] ];
			if ( '' !== $m[2] ) {
				$position['segment'] = (int) $m[2];
			}
			$out[ $m[1] ] = $position;
		}
		return [] === $out ? null : $out;
	}

}

<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * /messages/stream opens a `sources/<name>` subscription as the Log_Sources
 * registry entry's Tail, stamped and resumed by that stamp. A caller names a
 * registry entry, never a path.
 */
#[CoversClass( SSE_Out_Node::class )]
class MessagesStreamSourcesTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'messages-stream-' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		SSE_Out_Node::$acquire_slot   = null;
		SSE_Out_Node::$check_slot     = null;
		SSE_Out_Node::$diagnostic_log = null;
		parent::tearDown();
	}

	// ── open_subscription: file-mode sources ───────────────────────────────

	public function test_known_name_opens_one_file_mode_tail_stamped_by_registry_name(): void {
		$path = "{$this->tmp}/gyro-live.log";
		\file_put_contents( $path, "abcdefgh\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];

		$tails = ( new SSE_Out_Node() )->open_subscription( 'sources/gyro', null );

		$this->assertCount( 1, $tails );
		$tail = $tails[0];
		$this->assertInstanceOf( Tail_Node::class, $tail );
		$this->assertSame( 'sources/gyro', $tail->stamped_as() );
		$this->assertInstanceOf( \Newspack_Nodes\File_Tail_Node::class, $tail );
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
		$first = ( new SSE_Out_Node() )->open_subscription( 'sources/php', null )[0];
		$token = 'sources/php=' . $first->cursor_position();

		// The reopen carries it as Last-Event-ID and sends no positions param.
		$ctrl     = new SSE_Out_Node();
		$resumed  = self::positions_from_token( $token );
		$reopened = $ctrl->open_subscription( 'sources/php', $resumed )[0];
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

		$first = ( new SSE_Out_Node() )->open_subscription( 'sources/php', null )[0];
		$token = 'sources/php=' . $first->cursor_position();

		$ctrl     = new SSE_Out_Node();
		$reopened = $ctrl->open_subscription( 'sources/php', self::positions_from_token( $token ) )[0];
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

		$ctrl = new SSE_Out_Node();
		$tail = $ctrl->open_subscription( 'sources/php', self::positions_from_token( 'sources/php=:9' ) )[0];

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
		$first = ( new SSE_Out_Node() )->open_subscription( 'sources/php', null )[0];
		$token = 'sources/php=' . $first->cursor_position();

		// The gap: lines written while nothing is connected.
		\file_put_contents( $path, "gap-one\ngap-two\n", \FILE_APPEND );

		$ctrl     = new SSE_Out_Node();
		$reopened = $ctrl->open_subscription( 'sources/php', self::positions_from_token( $token ) )[0];
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

		$tail = ( new SSE_Out_Node() )->open_subscription( 'sources/gyro', null )[0];

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

		$tails = ( new SSE_Out_Node() )->open_subscription(
			'sources/gyro',
			[ 'sources/gyro' => [ 'segment' => 4242, 'offset' => 77 ] ]
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
			. "make_node Log beacon:log <config:logs_dir>/beacon-7e.p{partition}/beacon-7e 1 2 7\n"
		);
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lstream' ] ] );

		$tails = ( new SSE_Out_Node() )->open_subscription(
			'sources/beacon-7e.p1',
			[ 'sources/beacon-7e.p1' => [ 'segment' => 3, 'offset' => 9 ] ]
		);

		$this->assertCount( 1, $tails );
		$tail = $tails[0];
		$this->assertNotInstanceOf( \Newspack_Nodes\File_Tail_Node::class, $tail );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p1/beacon-7e", $this->read_private( $tail, 'source_file' ) );
		$this->assertSame( 'sources/beacon-7e.p1', $tail->stamped_as() );
		// Segmented seek seeds the cursor directly (Consumer's array branch).
		$this->assertSame( 3, $this->read_private( $tail, 'cursor_segment' ) );
		$this->assertSame( 9, $this->read_private( $tail, 'cursor_offset' ) );
	}

	// ── open_subscription: names only, never paths ─────────────────────────

	public function test_unknown_name_throws_a_teaching_error_listing_known_sources(): void {
		$path = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];
		$ctrl = new SSE_Out_Node();

		try {
			$ctrl->open_subscription( 'sources/nope-1189', null );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'unknown log source', $e->getMessage() );
			$this->assertStringContainsString( 'gyro', $e->getMessage(), 'the error teaches the known names' );
		}
	}

	public function test_a_caller_supplied_path_is_never_a_registry_name(): void {
		$path = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $path ];
		$ctrl = new SSE_Out_Node();

		foreach ( [ 'sources//etc/passwd', 'sources/../../etc/passwd', 'sources/gyro/../gyro' ] as $evil ) {
			try {
				$ctrl->open_subscription( $evil, null );
				$this->fail( "expected InvalidArgumentException for {$evil}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertStringContainsString( 'unknown log source', $e->getMessage() );
			}
		}
	}

	public function test_a_stream_naming_an_unknown_source_is_refused_before_it_opens(): void {
		$log                          = "{$this->tmp}/gyro.log";
		Log_Sources::$builtin_sources = static fn (): array => [ 'gyro' => $log ];
		SSE_Out_Node::$acquire_slot   = fn (): array|false => $this->fail( 'a refused stream takes no slot' );
		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose.p0,sources/nope-1189' );

		$result = ( new SSE_Out_Node() )->stream( $req );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 400, $result->get_error_data()['status'] );
		$this->assertStringContainsString( 'unknown log source: "nope-1189" (known: gyro', $result->get_error_message() );
	}

	public function test_a_stream_naming_an_explicit_logs_prefix_is_refused_before_it_opens(): void {
		SSE_Out_Node::$acquire_slot = fn (): array|false => $this->fail( 'a refused stream takes no slot' );
		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose.p0,logs/kea-7713.p3' );

		$result = ( new SSE_Out_Node() )->stream( $req );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'sse_subscription_invalid', $result->get_error_code() );
		$this->assertSame( 400, $result->get_error_data()['status'] );
		$this->assertSame( 'invalid subscription: logs/kea-7713.p3', $result->get_error_message() );
	}

	public function test_a_stream_naming_a_dir_the_guard_refuses_is_refused_before_it_opens(): void {
		\mkdir( "{$this->tmp}/offsets/Kea-6604.p2", 0755, true );
		$this->use_base_dir( $this->tmp );
		SSE_Out_Node::$acquire_slot = fn (): array|false => $this->fail( 'a refused stream takes no slot' );
		$req                        = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose.p0,offsets/Kea-6604.p2' );

		$result = ( new SSE_Out_Node() )->stream( $req );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'sse_subscription_invalid', $result->get_error_code() );
		$this->assertSame( 400, $result->get_error_data()['status'] );
		$this->assertSame( 'invalid subscription: offsets/Kea-6604.p2', $result->get_error_message() );
	}

	public function test_a_registry_that_will_not_read_propagates_as_a_server_error(): void {
		$broken                       = new \RuntimeException( 'registry fault 7719' );
		Log_Sources::$builtin_sources = static function () use ( $broken ): array {
			throw $broken;
		};
		SSE_Out_Node::$acquire_slot   = fn (): array|false => $this->fail( 'a failed stream takes no slot' );
		$req                          = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'sources/gyro' );

		try {
			( new SSE_Out_Node() )->stream( $req );
			$this->fail( 'the registry fault was turned into a refusal' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( $broken, $e );
		}
	}

	public function test_a_stream_reads_the_registry_once_for_a_source_it_opens(): void {
		$path  = "{$this->tmp}/gyro-3308.log";
		$reads = 0;
		\file_put_contents( $path, "gyro-3308\n" );
		Log_Sources::$builtin_sources = static function () use ( $path, &$reads ): array {
			++$reads;
			return [ 'gyro' => $path ];
		};
		$opened                       = new \RuntimeException( 'stop after the open 3308' );
		SSE_Out_Node::$acquire_slot   = static fn (): array => [ 'slot' => 4, 'owner' => 33083308 ];
		SSE_Out_Node::$check_slot     = static function () use ( $opened ): bool {
			throw $opened;
		};
		SSE_Out_Node::$diagnostic_log = static function (): void {};
		$ctrl                         = new class() extends SSE_Out_Node {
			protected function init_sse_headers(): void {}
		};
		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'sources/gyro' );

		\ob_start();
		try {
			$ctrl->stream( $req );
			$this->fail( 'the drain did not stop' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( $opened, $e );
		} finally {
			\ob_end_clean();
		}

		$this->assertSame( 1, $reads );
	}

	public function test_a_known_source_passes_the_check_without_listing_its_segments(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$dir                          = "{$this->tmp}/topologies";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/lcheck.tsl", "make_node Log beacon:log <config:logs_dir>/beacon-8f.jsonl 1 2 7\n" );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lcheck' ] ] );
		\mkdir( "{$this->tmp}/logs", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/beacon-8f.jsonl.4", "x\n" );
		\Newspack_Nodes\Partition_Node::$scandir = fn (): array => $this->fail( 'the check lists no segment' );
		SSE_Out_Node::$acquire_slot              = static fn (): array|false => false;
		$req                                     = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'sources/beacon-8f.jsonl' );

		try {
			$result = ( new SSE_Out_Node() )->stream( $req );
		} finally {
			\Newspack_Nodes\Partition_Node::$scandir = null;
		}

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'too_many_connections', $result->get_error_code(), 'the check passed and the slot refused' );
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

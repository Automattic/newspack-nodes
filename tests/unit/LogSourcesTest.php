<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * The shared log-source registry behind `list_logs`, `dump_log`, `read_message`
 * and the `sources/<name>` stream.
 *
 * Locks the {name => {path, mode}} entry shape and the three-family merge:
 * built-ins (file mode) → config `log_sources` (file mode) → active-topology
 * Log nodes (segmented mode), first name wins, realpath-deduped. A caller
 * always addresses a source by registry NAME — never a path.
 */
#[CoversClass( Log_Sources::class )]
class LogSourcesTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'log-sources-' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		parent::tearDown();
	}

	/** Register $tsl under a stock dir and activate it via the config overlay. */
	private function activate_topology( string $name, string $tsl, array $extras = [] ): void {
		$dir = "{$this->tmp}/topologies";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$name}.tsl", $tsl );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, \array_merge( [ 'topologies' => [ $name ] ], $extras ) );
	}

	// ── built-ins ──────────────────────────────────────────────────────────

	public function test_builtin_seam_entries_are_file_mode(): void {
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => '/x/custom-error-9713.log' ];

		$registry = Log_Sources::registry();

		$this->assertSame(
			[
				'path' => '/x/custom-error-9713.log',
				'mode' => Tail_Node::MODE_FILE,
			],
			$registry['php']
		);
	}

	public function test_builtin_default_resolver_reads_ini_error_log_and_wp_content_dir(): void {
		// Leave the seam null so the REAL resolver runs (ini_get + WP_CONTENT_DIR).
		Log_Sources::$builtin_sources = null;
		$php_log       = "{$this->tmp}/php-error-9302.log";
		\file_put_contents( $php_log, "x\n" );
		$original_ini  = \ini_get( 'error_log' );
		\ini_set( 'error_log', $php_log );
		if ( ! \defined( 'WP_CONTENT_DIR' ) ) {
			\define( 'WP_CONTENT_DIR', "{$this->tmp}/wp-content" );
		}

		try {
			$registry = Log_Sources::registry();
		} finally {
			\ini_set( 'error_log', false === $original_ini ? '' : $original_ini );
		}

		$this->assertSame( $php_log, $registry['php']['path'] );
		$this->assertSame( \WP_CONTENT_DIR . '/debug.log', $registry['debug']['path'] );
	}

	public function test_builtin_default_resolver_omits_php_when_error_log_ini_is_not_a_real_file(): void {
		Log_Sources::$builtin_sources = null;
		$original_ini = \ini_get( 'error_log' );
		\ini_set( 'error_log', "{$this->tmp}/does-not-exist-6614.log" );

		try {
			$registry = Log_Sources::registry();
		} finally {
			\ini_set( 'error_log', false === $original_ini ? '' : $original_ini );
		}

		$this->assertArrayNotHasKey( 'php', $registry );
	}

	// ── config log_sources ─────────────────────────────────────────────────

	public function test_config_entries_parse_name_equals_path_as_file_mode(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->use_base_dir( $this->tmp, [ 'log_sources' => [ 'gyro=/var/log/gyro-8841.log' ] ] );

		$registry = Log_Sources::registry();

		$this->assertSame(
			[
				'path' => '/var/log/gyro-8841.log',
				'mode' => Tail_Node::MODE_FILE,
			],
			$registry['gyro']
		);
	}

	public function test_malformed_config_entries_are_skipped(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->use_base_dir( $this->tmp, [
			'log_sources' => [
				'noequals',
				'Bad Name=/var/log/x.log',
				'rel=not/absolute',
				'dots=/a/../b.log',
				'keeper=/var/log/keeper-4471.log',
			],
		] );

		$registry = Log_Sources::registry();

		$this->assertSame( [ 'keeper' ], \array_keys( $registry ) );
	}

	public function test_builtin_name_wins_over_a_config_entry_with_the_same_name(): void {
		Log_Sources::$builtin_sources = static fn (): array => [ 'gate' => '/builtin/gate-first.log' ];
		$this->use_base_dir( $this->tmp, [ 'log_sources' => [ 'gate=/config/gate-second.log' ] ] );

		$this->assertSame( '/builtin/gate-first.log', Log_Sources::registry()['gate']['path'] );
	}

	public function test_realpath_dedupe_drops_a_config_alias_of_a_builtin_file(): void {
		$real = "{$this->tmp}/real-7e2.log";
		\file_put_contents( $real, "x\n" );
		$link = "{$this->tmp}/alias-7e2.log";
		\symlink( $real, $link );

		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $real ];
		$this->use_base_dir( $this->tmp, [ 'log_sources' => [ "phpalias={$link}" ] ] );

		$this->assertSame( [ 'php' ], \array_keys( Log_Sources::registry() ) );
	}

	// ── topology inference ─────────────────────────────────────────────────

	public function test_topology_log_without_partition_token_yields_one_segmented_source(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-single',
			"var num_partitions = 2\n"
			. "make_node Log gate:log <config:logs_dir>/Gate-Decisions.jsonl 1 2 7\n"
		);

		$registry = Log_Sources::registry();

		// Lowercased writes-basename; identical across partitions → ONE entry.
		$this->assertSame(
			[
				'path' => "{$this->tmp}/logs/Gate-Decisions.jsonl",
				'mode' => Tail_Node::MODE_SEGMENTED,
			],
			$registry['gate-decisions.jsonl']
		);
		$this->assertSame( [ 'gate-decisions.jsonl' ], \array_keys( $registry ) );
	}

	public function test_topology_log_with_partition_token_yields_one_source_per_partition(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-fleet',
			"var num_partitions = 2\n"
			. "make_node Log beacon:log <config:logs_dir>/beacon-7e.p<partition>/beacon-7e 1 2 7\n"
		);

		$registry = Log_Sources::registry();

		$this->assertSame( [ 'beacon-7e.p0', 'beacon-7e.p1' ], \array_keys( $registry ) );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p0/beacon-7e", $registry['beacon-7e.p0']['path'] );
		$this->assertSame( "{$this->tmp}/logs/beacon-7e.p1/beacon-7e", $registry['beacon-7e.p1']['path'] );
		$this->assertSame( Tail_Node::MODE_SEGMENTED, $registry['beacon-7e.p1']['mode'] );
	}

	public function test_a_broken_topology_fails_the_registry_after_every_topology_is_read(): void {
		$exploded = new \RuntimeException( 'resolver exploded-6048' );
		\Newspack_Nodes\Core::register_config_namespace(
			'lsboom',
			static function ( string $key ) use ( $exploded ): ?string {
				throw $exploded;
			}
		);
		Log_Sources::$builtin_sources = static fn (): array => [];
		$dir = "{$this->tmp}/topologies";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/lsbroken.tsl", "make_node Log b:log <lsboom:x>/boom.log 1 2 7\n" );
		\file_put_contents( "{$dir}/lsbroken2.tsl", "make_node Log c:log <nope:x>/dangling.log 1 2 7\n" );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lsbroken', 'lsbroken2' ] ] );

		$caught = null;
		try {
			Log_Sources::registry();
		} catch ( \Throwable $e ) {
			$caught = $e;
		}

		$this->assertInstanceOf( \Newspack_Nodes\Failures::class, $caught, 'both broken topologies report' );
		$this->assertSame( $exploded, $caught->all()[0] );
		$this->assertStringContainsString( 'nope:x', $caught->all()[1]->getMessage() );
	}

	public function test_non_log_nodes_in_the_graph_are_skipped(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-mixed',
			"make_node Echo e\n"
			. "make_node Log g:log <config:logs_dir>/echo-companion-91.log 1 2 7\n"
		);

		// The Echo node contributes nothing; only the Log node's source shows.
		$this->assertSame( [ 'echo-companion-91.log' ], \array_keys( Log_Sources::registry() ) );
	}

	public function test_log_node_missing_its_path_argument_is_skipped(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-incomplete',
			"make_node Log incomplete\n"
			. "make_node Log g:log <config:logs_dir>/present-55.log 1 2 7\n"
		);

		$this->assertSame( [ 'present-55.log' ], \array_keys( Log_Sources::registry() ) );
	}

	public function test_log_node_with_a_relative_path_is_skipped(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		// No leading '/' and no <ns:key> token to resolve — stays relative.
		$this->activate_topology( 'lsrc-relative', "make_node Log r:log relative-path-77/x.log 1 2 7\n" );

		$this->assertSame( [], Log_Sources::registry() );
	}

	// ── availability ───────────────────────────────────────────────────────

	public function test_is_available_checks_the_file_for_file_mode(): void {
		$path = "{$this->tmp}/live-31.log";
		\file_put_contents( $path, "x\n" );

		$this->assertTrue( Log_Sources::is_available( [ 'path' => $path, 'mode' => Tail_Node::MODE_FILE ] ) );
		$this->assertFalse( Log_Sources::is_available( [ 'path' => "{$this->tmp}/absent-31.log", 'mode' => Tail_Node::MODE_FILE ] ) );
	}

	public function test_is_available_checks_for_any_segment_in_segmented_mode(): void {
		// Segments are {file}.{seg}; retention may leave only a later segment.
		\file_put_contents( "{$this->tmp}/seg-base.7", "x\n" );

		$this->assertTrue( Log_Sources::is_available( [ 'path' => "{$this->tmp}/seg-base", 'mode' => Tail_Node::MODE_SEGMENTED ] ) );
		$this->assertFalse( Log_Sources::is_available( [ 'path' => "{$this->tmp}/no-segments", 'mode' => Tail_Node::MODE_SEGMENTED ] ) );
	}

	/**
	 * "Has segments" had two definitions in one file: `is_available()` asked the
	 * RAW glob, which matches the companion `{file}.{seg}.idx` a Log writes,
	 * while every other segmented read filtered to a purely-numeric suffix. So
	 * an orphaned `.idx` left behind after retention swept its data segment
	 * printed `AVAILABLE yes` / `BYTES -` for a source whose tail then answered
	 * `log unavailable`.
	 */
	public function test_is_available_ignores_an_orphaned_index_companion(): void {
		\file_put_contents( "{$this->tmp}/idx-only.4.idx", "0 0\n" );

		$this->assertFalse(
			Log_Sources::is_available( [ 'path' => "{$this->tmp}/idx-only", 'mode' => Tail_Node::MODE_SEGMENTED ] ),
			'an index companion is not a readable data segment'
		);
	}

	// ── catalog, footprint and the stepped read ──────────────────────────────

	/** Write $count rows of $width chars (+ newline) to a fresh temp file. */
	private function write_fixed_width_log( int $count, int $width ): string {
		$path  = "{$this->tmp}/tail-" . $count . 'x' . $width . '.log';
		$lines = [];
		for ( $i = 0; $i < $count; $i++ ) {
			$lines[] = \str_pad( \sprintf( 'evlog-line-%04d', $i ), $width, '.' );
		}
		\file_put_contents( $path, \implode( "\n", $lines ) . "\n" );
		return $path;
	}

	/** The stepped read `raw-logs read_message` drives, over one registry source. */
	private function read_source( string $name, string $position ): array {
		return Log_Sources::read( "sources/{$name}", $position );
	}

	public function test_catalog_lists_each_source_keyed_by_its_stamp(): void {
		$present = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present ];

		$this->assertSame(
			[ [ 'key' => 'sources/php', 'label' => 'php', 'available' => true ] ],
			Log_Sources::catalog()
		);
	}

	public function test_footprint_lists_a_segmented_sources_segments_sorted_by_id(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-segs',
			"var num_partitions = 1\n"
			. "make_node Log gate:log <config:logs_dir>/gate-decisions.jsonl 1 2 7\n"
		);
		$base = "{$this->tmp}/logs/gate-decisions.jsonl";
		\mkdir( "{$this->tmp}/logs", 0755, true );
		\file_put_contents( "{$base}.5", \str_repeat( 'b', 233 ) );
		\file_put_contents( "{$base}.3", \str_repeat( 'a', 977 ) );
		\file_put_contents( "{$base}.3.idx", 'not-a-segment' );

		$footprint = Log_Sources::footprint( 'sources/gate-decisions.jsonl' );

		$this->assertSame(
			[
				[
					'id'   => 3,
					'size' => 977,
				],
				[
					'id'   => 5,
					'size' => 233,
				],
			],
			$footprint['segments'],
			'sorted by id, sized, .idx companions excluded'
		);
		$this->assertSame( 1210, $footprint['total_size'], 'the summed segment sizes' );
	}

	public function test_a_source_whose_segment_listing_throws_shows_its_failure_in_the_catalog(): void {
		$present                      = $this->write_fixed_width_log( 2, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present ];
		$this->activate_topology(
			'lsrc-broken-listing',
			"var num_partitions = 1\n"
			. "make_node Log gate:log <config:logs_dir>/gate-decisions.jsonl 1 2 7\n"
		);
		\mkdir( "{$this->tmp}/logs", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/gate-decisions.jsonl.4", \str_repeat( 'c', 431 ) );
		Partition_Node::$scandir = static function ( string $dir ): array {
			throw new \RuntimeException( 'listing failed-9912' );
		};

		try {
			$rows = Log_Sources::catalog();
		} finally {
			Partition_Node::$scandir = null;
		}

		$by_key = \array_column( $rows, null, 'key' );
		$this->assertTrue( $by_key['sources/php']['available'] );
		$this->assertFalse( $by_key['sources/gate-decisions.jsonl']['available'] );
		$this->assertStringContainsString( 'listing failed-9912', $by_key['sources/gate-decisions.jsonl']['error'] );
	}

	/**
	 * A stop is collected like any other failure: every source is still
	 * offered its listing, and the stop escapes carrying what the rest threw.
	 */
	public function test_a_stop_while_listing_offers_every_source_and_carries_the_other_failures(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-stopping',
			"make_node Log a:log <config:logs_dir>/alpha-6610.jsonl 1 2 7\n"
			. "make_node Log b:log <config:logs_dir>/beta-6610.jsonl 1 2 7\n"
		);
		\mkdir( "{$this->tmp}/logs", 0755, true );
		$calls                   = 0;
		Partition_Node::$scandir = static function ( string $dir ) use ( &$calls ): array {
			if ( 1 === ++$calls ) {
				throw new \Newspack_Nodes\Worker_Should_Stop( 'stop-6610' );
			}
			throw new \RuntimeException( 'beta-failed-6610' );
		};

		try {
			$e = $this->caught( static fn () => Log_Sources::catalog(), 'the stop must escape' );
		} finally {
			Partition_Node::$scandir = null;
		}

		$this->assertSame( 2, $calls, 'the stop costs no later source its listing' );
		$this->assertInstanceOf( \Newspack_Nodes\Worker_Should_Stop::class, $e );
		$this->assertSame( 'beta-failed-6610', $e->getPrevious()?->getMessage() );
	}

	public function test_an_unreadable_topology_shows_in_the_listing_beside_the_readable_sources(): void {
		$present                      = $this->write_fixed_width_log( 2, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present ];
		$this->activate_topology( 'lsrc-dangling', "make_node Log d:log <nope:x>/dangling-4471.log 1 2 7\n" );

		$rows = Log_Sources::catalog();

		$this->assertSame( [ 'sources/php' ], \array_column( $rows, 'key' ), 'no row streams the topology' );
		$this->assertTrue( $rows[0]['available'] );
		$this->assertSame( [ 'label' => 'lsrc-dangling', 'available' => false ], \array_diff_key( $rows[1], [ 'error' => true ] ) );
		$this->assertStringContainsString( 'nope:x', $rows[1]['error'] );
	}

	public function test_an_unreadable_topology_named_like_a_source_keeps_both_rows(): void {
		$present                      = $this->write_fixed_width_log( 2, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'shared-6613' => $present ];
		$this->activate_topology( 'shared-6613', "make_node Log d:log <nope:x>/dangling-6613.log 1 2 7\n" );

		$rows = Log_Sources::catalog();

		$this->assertCount( 2, $rows );
		$this->assertSame( 'sources/shared-6613', $rows[0]['key'] );
		$this->assertTrue( $rows[0]['available'], 'the source keeps its own valid row' );
		$this->assertArrayNotHasKey( 'error', $rows[0] );
		$this->assertArrayNotHasKey( 'key', $rows[1], 'a topology is no stream' );
		$this->assertSame( 'shared-6613', $rows[1]['label'] );
		$this->assertFalse( $rows[1]['available'] );
		$this->assertStringContainsString( 'nope:x', $rows[1]['error'] );
	}

	public function test_a_name_missing_beside_an_unreadable_topology_raises_its_failure(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology( 'lsrc-dangling', "make_node Log d:log <nope:x>/dangling-4471.log 1 2 7\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'nope:x' );
		Log_Sources::footprint( 'sources/dangling-4471.log' );
	}

	public function test_read_source_returns_the_line_at_a_position_in_a_segment(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		$this->activate_topology(
			'lsrc-read',
			"var num_partitions = 1\n"
			. "make_node Log gate:log <config:logs_dir>/gate-decisions.jsonl 1 2 7\n"
		);
		\mkdir( "{$this->tmp}/logs", 0755, true );
		$line1 = "first decision 4194\n";
		$line2 = "second decision 977\n";
		\file_put_contents( "{$this->tmp}/logs/gate-decisions.jsonl.3", $line1 . $line2 );

		$result = $this->read_source( 'gate-decisions.jsonl', '3:0' );

		$this->assertSame( "first decision 4194\n", $result['message'][ \Newspack_Nodes\Message::VALUE ] );
		// The post-step cursor IS the next-line position.
		$this->assertSame(
			[
				'segment' => 3,
				'offset'  => \strlen( $line1 ),
			],
			$result['cursor']
		);

		// Stepping from the cursor yields line two; a trailing :length is ignored.
		$next = $this->read_source( 'gate-decisions.jsonl', '3:' . \strlen( $line1 ) . ':555' );
		$this->assertSame( "second decision 977\n", $next['message'][ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_read_source_file_mode_validates_the_inode_and_reads_at_offset(): void {
		$path = "{$this->tmp}/plain-9313.log";
		\file_put_contents( $path, "alpha line\nbeta line\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];
		$inode = (int) \fileinode( $path );

		// The segment slot is the file's inode (the breadcrumb round-trip).
		$result = $this->read_source( 'php', "{$inode}:11" );

		$this->assertSame( "beta line\n", $result['message'][ \Newspack_Nodes\Message::VALUE ] );
		$this->assertSame( $inode, $result['cursor']['segment'] );
		$this->assertSame( 21, $result['cursor']['offset'] );

		// A MISMATCHED inode (rotated-away generation) re-seeks to the file
		// start rather than reading a stale position: line one comes back.
		$stale = $this->read_source( 'php', '12345:11' );
		$this->assertSame( "alpha line\n", $stale['message'][ \Newspack_Nodes\Message::VALUE ] );
	}

	/**
	 * The Replay control seeks with the magic 'start' token, and Step then reads
	 * at the SAME position — so the read verb must speak the same position
	 * vocabulary as the seek transport. It used to reject the token as
	 * malformed, which is why pause → Replay → Step did nothing.
	 */
	public function test_read_source_accepts_the_magic_start_position(): void {
		$path = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$result = $this->read_source( 'php', 'start' );

		$this->assertIsArray( $result, 'start must read, not error' );
		$this->assertStringStartsWith(
			'evlog-line-0000',
			$result['message'][ \Newspack_Nodes\Message::VALUE ],
			'start reads the EARLIEST line'
		);
	}

	public function test_read_source_rejects_a_malformed_position(): void {
		$path = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'read_message: invalid position (want <segment>:<offset>[:<length>], start, recent or end)' );
		$this->read_source( 'php', 'abc' );
	}

	public function test_read_source_reports_no_line_on_an_empty_file(): void {
		// A past-EOF offset resumes from 0 (crash-resume forgiveness, the
		// cursor tells the truth); only a genuinely empty file has no line.
		$path = "{$this->tmp}/empty-7717.log";
		\file_put_contents( $path, '' );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$inode = (int) \fileinode( $path );
		$this->assertSame(
			[
				'source'  => 'sources/php',
				'message' => null,
				'cursor'  => [ 'segment' => $inode, 'offset' => 0 ],
				'at_eof'  => true,
			],
			$this->read_source( 'php', "{$inode}:0" )
		);
	}
}

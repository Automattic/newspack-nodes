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
 * The shared log-source registry `cmd_taillog` and `/log/stream` both consume.
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
				'sources=/var/log/reserved.log',
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

	public function test_a_broken_topology_is_skipped_not_fatal(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'lsboom',
			static function ( string $key ): ?string {
				throw new \RuntimeException( 'resolver exploded' );
			}
		);
		Log_Sources::$builtin_sources = static fn (): array => [];
		$dir = "{$this->tmp}/topologies";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/lsbroken.tsl", "make_node Log b:log <lsboom:x>/boom.log 1 2 7\n" );
		\file_put_contents( "{$dir}/lsgood.tsl", "make_node Log g:log <config:logs_dir>/still-here.md 1 2 7\n" );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'topologies' => [ 'lsbroken', 'lsgood' ] ] );

		$registry = Log_Sources::registry();

		$this->assertSame( [ 'still-here.md' ], \array_keys( $registry ) );
	}

	public function test_an_unresolvable_config_token_skips_that_topology(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		// `<nope:x>` is unregistered: strict token validation throws, and the
		// catch degrades to skipping the topology (never a '/dangling.log' ghost).
		$this->activate_topology( 'lsrel', "make_node Log r:log <nope:x>/dangling.log 1 2 7\n" );

		$this->assertSame( [], Log_Sources::registry() );
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

	public function test_log_node_whose_derived_name_is_the_reserved_sources_word_is_skipped(): void {
		Log_Sources::$builtin_sources = static fn (): array => [];
		// writes-basename of the path arg resolves to the reserved word "sources".
		$this->activate_topology( 'lsrc-reserved', "make_node Log s:log <config:logs_dir>/sources 1 2 7\n" );

		$this->assertSame( [], Log_Sources::registry() );
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

	public function test_tail_path_resolves_the_newest_segment_for_segmented_mode(): void {
		// `taillog` tails a single FILE; for a segmented source that is the
		// NEWEST {file}.{seg} (numeric, not lexical: 10 > 9).
		\file_put_contents( "{$this->tmp}/seg-base.9", "old\n" );
		\file_put_contents( "{$this->tmp}/seg-base.10", "new\n" );

		$this->assertSame(
			"{$this->tmp}/seg-base.10",
			Log_Sources::tail_path( [ 'path' => "{$this->tmp}/seg-base", 'mode' => Tail_Node::MODE_SEGMENTED ] )
		);
	}

	public function test_tail_path_passes_a_file_mode_path_through_and_nulls_a_bare_segmented_base(): void {
		$this->assertSame(
			'/var/log/direct-6120.log',
			Log_Sources::tail_path( [ 'path' => '/var/log/direct-6120.log', 'mode' => Tail_Node::MODE_FILE ] )
		);
		$this->assertNull(
			Log_Sources::tail_path( [ 'path' => "{$this->tmp}/no-segments", 'mode' => Tail_Node::MODE_SEGMENTED ] ),
			'a segmented source with no segments on disk has nothing to tail'
		);
	}

	// ── taillog (moved off Command_Interpreter_Node) ─────────────────────────

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

	public function test_taillog_tails_the_last_bytes_and_drops_the_partial_first_line(): void {
		// 40 rows x 60 bytes = 2400 bytes; a 1KB tail lands mid-row 22, so the
		// first WHOLE row is 0023 — distinct from the 16KB default window.
		$path = $this->write_fixed_width_log( 40, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$out = Log_Sources::taillog( [ 'php', '1' ] );

		$this->assertStringStartsWith( 'evlog-line-0023', $out );
		$this->assertStringNotContainsString( 'evlog-line-0000', $out );
		$this->assertStringContainsString( 'evlog-line-0039', $out );
	}

	public function test_taillog_no_source_lists_the_registry_with_availability(): void {
		$present = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present ];

		$out = Log_Sources::taillog( [] );

		$this->assertStringContainsString( 'SOURCE', $out );
		$this->assertStringContainsString( 'AVAILABLE', $out );
		$this->assertStringContainsString( $present, $out );
		$this->assertStringContainsString( '180', $out, '3 rows x 60 bytes' );
	}

	public function test_taillog_sources_returns_a_struct_of_rows(): void {
		$present = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present ];

		$rows = Log_Sources::taillog( [ 'sources' ] );

		$this->assertSame(
			[
				[
					'name'      => 'php',
					'path'      => $present,
					'mode'      => 'file',
					'available' => true,
					'bytes'     => \filesize( $present ),
					'segments'  => [],
				],
			],
			$rows
		);
	}

	public function test_taillog_sources_lists_a_segmented_sources_segments_sorted_by_id(): void {
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

		$rows = Log_Sources::taillog( [ 'sources' ] );

		$this->assertCount( 1, $rows );
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
			$rows[0]['segments'],
			'sorted by id, sized, .idx companions excluded'
		);
		$this->assertSame( 233, $rows[0]['bytes'], 'bytes = the newest segment size' );
	}

	/**
	 * `taillog sources` lists the whole registry, so a listing that throws for ONE
	 * entry must cost that entry its segments, never the entire reply — the whole
	 * point of a debugging surface is to survive the broken thing being debugged.
	 */
	public function test_a_source_whose_segment_listing_throws_degrades_to_no_segments(): void {
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
			throw new \RuntimeException( "listing failed for {$dir}" );
		};

		try {
			$rows = Log_Sources::taillog( [ 'sources' ] );
		} finally {
			Partition_Node::$scandir = null;
		}

		$by_name = \array_column( $rows, null, 'name' );
		$this->assertSame( [], $by_name['gate-decisions.jsonl']['segments'] );
		$this->assertFalse( $by_name['gate-decisions.jsonl']['available'] );
		$this->assertNull( $by_name['gate-decisions.jsonl']['bytes'] );
		$this->assertTrue( $by_name['php']['available'], 'the healthy entry still lists' );
		$this->assertSame( \filesize( $present ), $by_name['php']['bytes'] );
	}

	public function test_taillog_read_returns_the_line_at_a_position_in_a_segment(): void {
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

		$result = Log_Sources::taillog( [ 'read', 'gate-decisions.jsonl', '3:0' ] );

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
		$next = Log_Sources::taillog( [ 'read', 'gate-decisions.jsonl', '3:' . \strlen( $line1 ) . ':555' ] );
		$this->assertSame( "second decision 977\n", $next['message'][ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_taillog_read_file_mode_validates_the_inode_and_reads_at_offset(): void {
		$path = "{$this->tmp}/plain-9313.log";
		\file_put_contents( $path, "alpha line\nbeta line\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];
		$inode = (int) \fileinode( $path );

		// The segment slot is the file's inode (the breadcrumb round-trip).
		$result = Log_Sources::taillog( [ 'read', 'php', "{$inode}:11" ] );

		$this->assertSame( "beta line\n", $result['message'][ \Newspack_Nodes\Message::VALUE ] );
		$this->assertSame( $inode, $result['cursor']['segment'] );
		$this->assertSame( 21, $result['cursor']['offset'] );

		// A MISMATCHED inode (rotated-away generation) re-seeks to the file
		// start rather than reading a stale position: line one comes back.
		$stale = Log_Sources::taillog( [ 'read', 'php', '12345:11' ] );
		$this->assertSame( "alpha line\n", $stale['message'][ \Newspack_Nodes\Message::VALUE ] );
	}

	/**
	 * The Replay control seeks with the magic 'start' token, and Step then reads
	 * at the SAME position — so the read verb must speak the same position
	 * vocabulary as the seek transport. It used to reject the token as
	 * malformed, which is why pause → Replay → Step did nothing.
	 */
	public function test_taillog_read_accepts_the_magic_start_position(): void {
		$path = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$result = Log_Sources::taillog( [ 'read', 'php', 'start' ] );

		$this->assertIsArray( $result, 'start must read, not error' );
		$this->assertStringStartsWith(
			'evlog-line-0000',
			$result['message'][ \Newspack_Nodes\Message::VALUE ],
			'start reads the EARLIEST line'
		);
	}

	public function test_taillog_read_rejects_a_malformed_position(): void {
		$path = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$this->assertSame(
			"taillog read: invalid position (want <segment>:<offset>[:<length>], start, recent or end)\n",
			Log_Sources::taillog( [ 'read', 'php', 'abc' ] )
		);
	}

	/**
	 * `read_at()` receives an ALREADY-armed reader: `open_tail()` has run
	 * `arguments()`, which calls `set_timer()` and registers the node with the
	 * Event_Framework. Returning the invalid-position error before the
	 * `finally` left that reader in the timer table forever, and its next fire
	 * reached `Node::fill()` with a null sink inside the worker's drain loop.
	 */
	public function test_read_at_removes_the_armed_reader_when_the_position_is_invalid(): void {
		$path = "{$this->tmp}/armed-8823.log";
		\file_put_contents( $path, "only line 8823\n" );
		$reader = Log_Sources::open_tail( [ 'path' => $path, 'mode' => Tail_Node::MODE_FILE ] );
		$this->assertTrue( $reader->timer_is_active(), 'open_tail arms the reader' );

		$out = Log_Sources::read_at( $reader, 'armed', 'not-a-position', 'taillog read' );

		$this->assertStringStartsWith( 'taillog read: invalid position', $out );
		$this->assertFalse( $reader->timer_is_active(), 'a rejected reader must not stay armed' );
	}

	public function test_taillog_read_reports_no_line_on_an_empty_file(): void {
		// A past-EOF offset resumes from 0 (crash-resume forgiveness, the
		// cursor tells the truth); only a genuinely empty file has no line.
		$path = "{$this->tmp}/empty-7717.log";
		\file_put_contents( $path, '' );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$inode = (int) \fileinode( $path );
		$this->assertSame(
			"taillog read: no record at php {$inode}:0\n",
			Log_Sources::taillog( [ 'read', 'php', "{$inode}:0" ] )
		);
	}

	public function test_read_is_a_reserved_source_name(): void {
		$this->assertFalse( Log_Sources::is_valid_name( 'read' ) );
	}

	public function test_taillog_rejects_an_unknown_source_name_never_a_path(): void {
		$path = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$out = Log_Sources::taillog( [ '../../../../etc/passwd' ] );

		$this->assertStringContainsString( 'unknown log source', $out );
		$this->assertStringNotContainsString( 'root:', $out );
	}
}

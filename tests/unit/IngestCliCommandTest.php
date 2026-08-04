<?php
/**
 * Tests for `wp nodes ingest <topic> <file>...` — replays packed partition
 * segment records back through Topic::fill() onto disk.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Ingest_CLI_Command;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-ingest-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Ingest_CLI_Command::class )]
class IngestCliCommandTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$staging = (string) \realpath( \sys_get_temp_dir() ) . '/newspack-nodes-ingest-test-' . \uniqid();
		\mkdir( $staging, 0755, true );
		$this->tmp = \realpath( $staging ) ?: $staging;

		$GLOBALS['_test_wp_cli_logs']    = [];
		$GLOBALS['_test_wp_cli_warns']   = [];
		$GLOBALS['_test_wp_cli_errors']  = [];
		$GLOBALS['_test_wp_cli_success'] = [];
		// Reset registered filters so a producer/topology declared in one test
		// doesn't leak into the next (the stub stores them in _wp_actions).
		$GLOBALS['_wp_actions'] = [];

		$this->use_base_dir( $this->tmp );
		Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Write a source segment file of packed [KEY, VALUE] records. */
	private function write_packed_records( string $path, array $kv ): void {
		$dir = \dirname( $path );
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$out = '';
		foreach ( $kv as [ $key, $value ] ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::KEY ]   = $key;
			$message[ Message::VALUE ] = $value;
			$out                      .= Message::packed( $message ) . "\n";
		}
		\file_put_contents( $path, $out );
	}

	/** Read every VALUE written across a destination topic's partition dirs. */
	private function collect_destination_values( string $base, string $name, int $n ): array {
		$values = [];
		for ( $i = 0; $i < $n; ++$i ) {
			$dir = "{$base}/{$name}.p{$i}";
			foreach ( \glob( "{$dir}/*.log" ) ?: [] as $segment ) {
				$lines = \array_filter( \explode( "\n", (string) \file_get_contents( $segment ) ), static fn ( $l ) => '' !== $l );
				foreach ( $lines as $line ) {
					$values[] = Message::unpacked( $line )[ Message::VALUE ];
				}
			}
		}
		return $values;
	}

	/** Set the global config num_partitions (the shortname-form default). */
	private function set_config_num_partitions( int $n ): void {
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => $n ] );
		\Newspack_Nodes\Config::reset();
	}

	// -------------------------------------------------------------------------
	// explicit dir_template form
	// -------------------------------------------------------------------------

	public function test_ingest_replays_records_into_destination_partition_segments(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [
			[ 'k1', 'first' ],
			[ 'k2', 'second' ],
		] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 2 ]
		);

		$values = $this->collect_destination_values( "{$this->tmp}/dest", 'firehose', 2 );
		\sort( $values );
		$this->assertSame( [ 'first', 'second' ], $values );
	}

	public function test_ingest_counts_unparseable_lines_without_crashing(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'first' ], [ 'k2', 'second' ] ] );
		\file_put_contents( $src, "not-a-packed-record\n", \FILE_APPEND );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 2 ]
		);

		$this->assertStringContainsString(
			'Ingested 2 record(s)',
			\implode( "\n", $GLOBALS['_test_wp_cli_success'] )
		);
		$this->assertStringContainsString(
			'1 unparseable',
			\implode( "\n", $GLOBALS['_test_wp_cli_warns'] )
		);
		// The two good records still landed.
		$values = $this->collect_destination_values( "{$this->tmp}/dest", 'firehose', 2 );
		$this->assertCount( 2, $values );
	}

	// -------------------------------------------------------------------------
	// shortname form — count defaults to the global config num_partitions
	// -------------------------------------------------------------------------

	public function test_ingest_shortname_defaults_to_config_num_partitions(): void {
		$this->set_config_num_partitions( 2 );
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'first' ], [ 'k2', 'second' ] ] );

		// No --num_partitions: the count comes from the global config (2).
		( new Ingest_CLI_Command() )->ingest( [ 'firehose', $src ], [] );

		$values = $this->collect_destination_values( "{$this->tmp}/logs", 'firehose', 2 );
		\sort( $values );
		$this->assertSame( [ 'first', 'second' ], $values );
	}

	public function test_ingest_shortname_respects_num_partitions_override(): void {
		$this->set_config_num_partitions( 2 );
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'a' ], [ 'k2', 'b' ], [ 'k3', 'c' ] ] );

		// --num_partitions overrides the config default.
		( new Ingest_CLI_Command() )->ingest( [ 'firehose', $src ], [ 'num_partitions' => 3 ] );

		$this->assertStringContainsString( '(3 partition(s)', \implode( "\n", $GLOBALS['_test_wp_cli_logs'] ) );
		$this->assertCount( 3, $this->collect_destination_values( "{$this->tmp}/logs", 'firehose', 3 ) );
	}

	public function test_ingest_explicit_template_trusts_user_num_partitions(): void {
		// Explicit dir_template with a {partition} token: NO declared-set lookup, NO
		// mismatch check — the operator owns the layout.
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'a' ], [ 'k2', 'b' ], [ 'k3', 'c' ], [ 'k4', 'd' ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ '<config:logs_dir>/firehose.p<partition>', $src ],
			[ 'num_partitions' => 4 ]
		);

		// All four records landed across the user-requested 4-partition layout.
		$values = $this->collect_destination_values( "{$this->tmp}/logs", 'firehose', 4 );
		$this->assertCount( 4, $values );
	}

	// -------------------------------------------------------------------------
	// oversize records + large-write flags
	// -------------------------------------------------------------------------

	public function test_ingest_default_skips_oversize_records_and_counts_them(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', \str_repeat( 'x', 5000 ) ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1 ]
		);

		$this->assertStringContainsString( 'Ingested 0 record(s)', \implode( "\n", $GLOBALS['_test_wp_cli_success'] ) );
		$this->assertStringContainsString( '1 oversize', \implode( "\n", $GLOBALS['_test_wp_cli_warns'] ) );
		$this->assertCount( 0, $this->collect_destination_values( "{$this->tmp}/dest", 'firehose', 1 ) );
	}

	public function test_ingest_void_warranty_writes_oversize_records(): void {
		$big = \str_repeat( 'x', 5000 );
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', $big ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'void_warranty' => true ]
		);

		$this->assertStringContainsString( 'Ingested 1 record(s)', \implode( "\n", $GLOBALS['_test_wp_cli_success'] ) );
		$this->assertSame( [ $big ], $this->collect_destination_values( "{$this->tmp}/dest", 'firehose', 1 ) );
	}

	public function test_ingest_allow_large_writes_writes_oversize_records(): void {
		$big = \str_repeat( 'z', 5000 );
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', $big ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'allow_large_writes' => true ]
		);

		$this->assertStringContainsString( 'Ingested 1 record(s)', \implode( "\n", $GLOBALS['_test_wp_cli_success'] ) );
		$this->assertSame( [ $big ], $this->collect_destination_values( "{$this->tmp}/dest", 'firehose', 1 ) );
	}

	public function test_ingest_refuses_both_large_write_flags(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'a' ] ] );

		$this->expectException( \RuntimeException::class );
		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'allow_large_writes' => true, 'void_warranty' => true ]
		);
	}

	// -------------------------------------------------------------------------
	// --dry-run
	// -------------------------------------------------------------------------

	public function test_ingest_dry_run_reports_oversize_and_writes_nothing(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'small' ], [ 'k2', \str_repeat( 'x', 5000 ) ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'dry-run' => true ]
		);

		$haystack = \implode( "\n", \array_merge( $GLOBALS['_test_wp_cli_logs'], $GLOBALS['_test_wp_cli_warns'] ) );
		$this->assertStringContainsString( 'exceed', $haystack );
		$this->assertStringContainsString( '--allow_large_writes', $haystack );
		$this->assertStringContainsString( '--void_warranty', $haystack );
		$this->assertFalse( \is_dir( "{$this->tmp}/dest/firehose.p0" ), 'dry run wrote nothing' );
		$this->assertEmpty( $GLOBALS['_test_wp_cli_success'], 'dry run emits no Ingested success line' );
	}

	/**
	 * The dry run exists to answer "do I need the large-write flag?", and in
	 * the one configuration where that question is live it answered backwards.
	 * `ingest()` counts oversize against the EFFECTIVE cap — 32 MiB once a
	 * flag is passed — while `report()` opened with its own hardcoded 4096 and
	 * phrased every message against it. So a corpus of 5000-byte records probed
	 * WITH the flag reported "all records within the 4096-byte PIPE_BUF cap; no
	 * large-write flag needed". An operator following that advice re-runs
	 * without it and Partition_Node::fill() silently drops every one.
	 */
	public function test_dry_run_with_the_flag_still_reports_the_pipe_buf_cap(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', \str_repeat( 'x', 5000 ) ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[
				'num_partitions'     => 1,
				'dry-run'            => true,
				'allow_large_writes' => true,
			]
		);

		$haystack = \implode(
			"\n",
			\array_merge( $GLOBALS['_test_wp_cli_logs'], $GLOBALS['_test_wp_cli_warns'] )
		);
		$this->assertStringNotContainsString(
			'no large-write flag needed',
			$haystack,
			'5000-byte records DO need the flag; saying otherwise loses them'
		);
		$this->assertStringContainsString( 'exceed', $haystack );
	}

	public function test_ingest_dry_run_clean_reports_no_large_write_flag_needed(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'small' ], [ 'k2', 'also-small' ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'dry-run' => true ]
		);

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'no large-write flag needed', $haystack );
		$this->assertFalse( \is_dir( "{$this->tmp}/dest/firehose.p0" ), 'dry run wrote nothing' );
	}

	// -------------------------------------------------------------------------
	// validation — don't suppress errors
	// -------------------------------------------------------------------------

	public function test_ingest_with_no_files_reads_zero_records_from_empty_stdin(): void {
		// Omitting <file>... no longer errors outright — it falls back to reading
		// packed records from stdin. An empty, non-tty stdin stream yields zero
		// records and no error (the interactive-terminal guard is a separate path).
		$mem = \fopen( 'php://memory', 'r+' );
		\rewind( $mem );
		Ingest_CLI_Command::$stdin_provider = static fn () => $mem;
		try {
			( new Ingest_CLI_Command() )->ingest(
				[ "{$this->tmp}/dest/firehose.p{partition}" ],
				[ 'num_partitions' => 1 ]
			);
		} finally {
			Ingest_CLI_Command::$stdin_provider = null;
		}

		$this->assertStringContainsString( 'Ingested 0 record(s)', \implode( "\n", $GLOBALS['_test_wp_cli_success'] ) );
	}

	public function test_ingest_with_no_files_replays_packed_records_piped_on_stdin(): void {
		$mem = \fopen( 'php://memory', 'r+' );
		foreach ( [ [ 'k1', 'first' ], [ 'k2', 'second' ] ] as [ $key, $value ] ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::KEY ]   = $key;
			$message[ Message::VALUE ] = $value;
			\fwrite( $mem, Message::packed( $message ) . "\n" );
		}
		\rewind( $mem );
		Ingest_CLI_Command::$stdin_provider = static fn () => $mem;
		try {
			( new Ingest_CLI_Command() )->ingest(
				[ "{$this->tmp}/dest/firehose.p{partition}" ],
				[ 'num_partitions' => 2 ]
			);
		} finally {
			Ingest_CLI_Command::$stdin_provider = null;
		}

		$values = $this->collect_destination_values( "{$this->tmp}/dest", 'firehose', 2 );
		\sort( $values );
		$this->assertSame( [ 'first', 'second' ], $values );
	}

	public function test_ingest_errors_on_unreadable_file(): void {
		$this->expectException( \RuntimeException::class );
		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", "{$this->tmp}/does-not-exist.log" ],
			[ 'num_partitions' => 1 ]
		);
	}

	public function test_ingest_refuses_a_directory_passed_as_a_file(): void {
		// Segments live under per-partition DIRS; passing a dir would fopen-succeed
		// then read nothing — refuse it instead of silently ingesting zero records.
		\mkdir( "{$this->tmp}/a-directory", 0755, true );
		$this->expectException( \RuntimeException::class );
		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", "{$this->tmp}/a-directory" ],
			[ 'num_partitions' => 1 ]
		);
	}

	public function test_ingest_rejects_non_numeric_num_partitions(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'a' ] ] );
		$this->expectException( \RuntimeException::class );
		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 'four' ]
		);
	}

	public function test_ingest_allow_large_writes_releases_the_write_lock(): void {
		// allow_large_writes acquires a held per-partition lock; the run must release
		// it (remove_node) so a back-to-back ingest / live worker isn't blocked.
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', \str_repeat( 'z', 5000 ) ] ] );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'allow_large_writes' => true ]
		);

		$this->assertFalse(
			\is_dir( "{$this->tmp}/dest/firehose.p0/write.lock.d" ),
			'the per-partition write lock was released after the run'
		);
	}

	// -------------------------------------------------------------------------
	// segment geometry (--segment_size / --num_segments) — the topicprobe re-segment case
	// -------------------------------------------------------------------------

	public function test_ingest_writes_at_the_requested_segment_size(): void {
		// A small segment_size re-segments the destination: oversized records on the
		// void_warranty path rotate per record, producing more than one .log segment.
		$src     = "{$this->tmp}/src.log";
		$records = [];
		for ( $i = 0; $i < 5; ++$i ) {
			$records[] = [ "k{$i}", \str_repeat( 'x', 5000 ) ];
		}
		$this->write_packed_records( $src, $records );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'segment_size' => 5000, 'num_segments' => 100, 'void_warranty' => true ]
		);

		$segments = \glob( "{$this->tmp}/dest/firehose.p0/*.log" ) ?: [];
		$this->assertGreaterThan( 1, \count( $segments ), 'the small segment_size rotated into multiple segments' );
	}

	public function test_ingest_honors_num_segments_instead_of_inheriting_a_lifetime_floor(): void {
		// --num_segments is a COUNT rule, and the count rule only fires on segments
		// older than min_lifetime. Leaving min_lifetime to inherit <config:*> (an
		// hour) protects every freshly-written segment, so the flag did nothing.
		$src     = "{$this->tmp}/src.log";
		$records = [];
		for ( $i = 0; $i < 8; ++$i ) {
			$records[] = [ "k{$i}", \str_repeat( 'x', 5000 ) ];
		}
		$this->write_packed_records( $src, $records );

		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'segment_size' => 5000, 'num_segments' => 3, 'void_warranty' => true ]
		);

		$segments = \glob( "{$this->tmp}/dest/firehose.p0/*.log" ) ?: [];
		$this->assertCount( 3, $segments, '--num_segments prunes the oldest back to the requested count' );
	}

	public function test_ingest_rejects_non_numeric_segment_size(): void {
		$src = "{$this->tmp}/src.log";
		$this->write_packed_records( $src, [ [ 'k1', 'a' ] ] );
		$this->expectException( \RuntimeException::class );
		( new Ingest_CLI_Command() )->ingest(
			[ "{$this->tmp}/dest/firehose.p{partition}", $src ],
			[ 'num_partitions' => 1, 'segment_size' => 'big' ]
		);
	}
}

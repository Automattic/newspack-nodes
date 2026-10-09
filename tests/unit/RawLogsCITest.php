<?php
/**
 * RawLogsCITest: unit tests for the substrate Raw_Logs_CI, which owns the
 * `list_logs` (catalog) + `dump_log` (per-partition metadata)
 * verbs the Raw Logs admin dashboard subscribes to.
 *
 * Replaces the verbs' previous home on the application's Performance_CI;
 * patterns here mirror the legacy PerformanceCITest firehose_* tests.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\Raw_Logs_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Raw_Logs_CI_Node::class )]
class RawLogsCITest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_actions']               = [];
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/raw-logs-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		Log_Sources::$builtin_sources = static fn (): array => [];
		Topology_Registry::reset();
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 1, 'topologies' => [] ] );
		Log_Discovery::reset();
	}

	protected function tearDown(): void {
		Log_Sources::$builtin_sources = null;
		Topology_Registry::reset();
		VerbHarness::reset();
		Log_Discovery::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	// -------------------------------------------------------------------------
	// schema + list_logs verb — disk-discovered catalog.
	// -------------------------------------------------------------------------

	public function test_list_logs_verb_returns_sorted_disk_catalog(): void {
		// Three concrete partition dirs on disk; the verb returns a sorted
		// catalog of {key, label} pairs where both are the concrete dir name
		// verbatim (flat partition-in-name layout) — the shape the React picker
		// mounts on.
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/logs/jobs.p0',     0755, true );
		\mkdir( $this->tmp . '/logs/requests.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[ 'key' => 'firehose.p0', 'label' => 'firehose.p0', 'available' => true ],
				[ 'key' => 'jobs.p0',     'label' => 'jobs.p0', 'available' => true ],
				[ 'key' => 'requests.p0', 'label' => 'requests.p0', 'available' => true ],
			],
			$result
		);
	}

	public function test_list_logs_verb_returns_empty_when_no_logs_dir(): void {
		// No logs/ dir means no glob matches — the picker shows an empty
		// list and the dashboard renders a "no logs" affordance.
		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );
		$this->assertSame( [], $result );
	}

	public function test_list_logs_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	// -------------------------------------------------------------------------
	// dump_log verb — per-partition segment metadata.
	// -------------------------------------------------------------------------

	public function test_dump_log_answers_the_segment_summary(): void {
		\mkdir( $this->tmp . '/logs/renamed.p3', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'dump_log', 'renamed.p3' );

		$this->assertIsArray( $result );
		$this->assertSame( 'renamed.p3', $result['log_id'] );
		$this->assertArrayHasKey( 'segments', $result );
	}

	/** The verb is `dump_log`; the noun-first name is refused, not aliased. */
	public function test_log_status_is_refused_as_an_unknown_command(): void {
		\mkdir( $this->tmp . '/logs/renamed.p3', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status', 'renamed.p3' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'unknown command: log_status', $result );
	}

	public function test_dump_log_verb_returns_single_dir_summary(): void {
		// `log` is now a CONCRETE partition dir name; the verb stats THAT one
		// dir's segments (no num_partitions loop, no nested `/p{N}`).
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'dump_log',
			'firehose.p0'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'firehose.p0', $result['log_id'] );
		$this->assertArrayHasKey( 'segments', $result );
		$this->assertArrayHasKey( 'segment_count', $result );
		$this->assertArrayHasKey( 'total_size', $result );
	}

	public function test_dump_log_refuses_an_unknown_log(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'dump_log', 'kea-7713.p9' );

		$this->assertSame( "unknown log: \"kea-7713.p9\"\n", $result );
	}

	public function test_dump_log_refuses_an_empty_log_at_the_binder(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'dump_log', '' );

		$this->assertSame( "missing required argument: log\n", $result );
	}

	public function test_list_logs_includes_offsets_and_deadletter_keys(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/offsets/combined.firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/deadletter/job-worker.jobs.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[
					'key'       => 'firehose.p0',
					'label'     => 'firehose.p0',
					'available' => true,
				],
				[
					'key'       => 'offsets/combined.firehose.p0',
					'label'     => 'offsets/combined.firehose.p0',
					'available' => true,
				],
				[
					'key'       => 'deadletter/job-worker.jobs.p0',
					'label'     => 'deadletter/job-worker.jobs.p0',
					'available' => true,
				],
			],
			$result
		);
	}

	public function test_list_logs_shows_a_logs_dir_named_like_a_group_as_an_error_row(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/logs/deadletter', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[
					'label'     => 'deadletter',
					'available' => false,
					'error'     => 'log dir deadletter is named like a group; rename it',
				],
				[ 'key' => 'firehose.p0', 'label' => 'firehose.p0', 'available' => true ],
			],
			$result
		);
	}

	public function test_list_logs_shows_a_dir_no_stamp_can_name_as_an_error_row(): void {
		\mkdir( $this->tmp . '/offsets/Kea-5512.p4', 0755, true );
		\mkdir( $this->tmp . '/offsets/kea-5512.p4', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[
					'label'     => 'Kea-5512.p4',
					'available' => false,
					'error'     => 'log dir Kea-5512.p4 is no stamp a stream can name; rename it',
				],
				[ 'key' => 'offsets/kea-5512.p4', 'label' => 'offsets/kea-5512.p4', 'available' => true ],
			],
			$result
		);
	}

	public function test_list_logs_lists_registry_sources_after_the_dirs(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );
		$present = $this->tmp . '/php-errors-4194.log';
		$absent  = $this->tmp . '/absent-977.log';
		\file_put_contents( $present, "PHP Notice: 977\n" );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present, 'debug' => $absent ];

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[ 'key' => 'firehose.p0', 'label' => 'firehose.p0', 'available' => true ],
				[ 'key' => 'sources/php', 'label' => 'php', 'available' => true ],
				[ 'key' => 'sources/debug', 'label' => 'debug', 'available' => false ],
			],
			$result
		);
	}

	public function test_dump_log_lists_a_file_source_as_one_segment_its_inode_at_its_size(): void {
		$path = $this->tmp . '/php-errors-4194.log';
		\file_put_contents( $path, \str_repeat( 'n', 977 ) );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'dump_log', 'sources/php' );

		$this->assertSame(
			[
				'log_id'        => 'sources/php',
				'segments'      => [ [ 'id' => \fileinode( $path ), 'size' => 977 ] ],
				'segment_count' => 1,
				'total_size'    => 977,
			],
			$result
		);
	}

	public function test_dump_log_lists_a_segmented_sources_segments(): void {
		$dir = $this->tmp . '/topologies';
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/rlseg.tsl", "make_node Log gate:log <config:logs_dir>/gate-4194.jsonl 1 2 7\n" );
		Topology_Registry::register_stock_dir( $dir );
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 1, 'topologies' => [ 'rlseg' ] ] );
		\mkdir( $this->tmp . '/logs', 0755, true );
		\file_put_contents( $this->tmp . '/logs/gate-4194.jsonl.3', \str_repeat( 'a', 977 ) );
		\file_put_contents( $this->tmp . '/logs/gate-4194.jsonl.5', \str_repeat( 'b', 233 ) );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'dump_log', 'sources/gate-4194.jsonl' );

		$this->assertSame( [ [ 'id' => 3, 'size' => 977 ], [ 'id' => 5, 'size' => 233 ] ], $result['segments'] );
		$this->assertSame( 2, $result['segment_count'] );
		$this->assertSame( 1210, $result['total_size'] );
	}

	public function test_dump_log_refuses_an_unknown_source(): void {
		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'dump_log', 'sources/nope-977' );

		$this->assertSame( "unknown log source: \"nope-977\" (known: none)\n", $result );
	}

	public function test_dump_log_reads_a_deadletter_dir_by_grouped_key(): void {
		$seg_dir = $this->tmp . '/deadletter/job-worker.jobs.p0';
		\mkdir( $seg_dir, 0755, true );
		\file_put_contents( "{$seg_dir}/7.log", \str_repeat( 'q', 977 ) );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'dump_log',
			'deadletter/job-worker.jobs.p0'
		);

		$this->assertSame( 'deadletter/job-worker.jobs.p0', $result['log_id'] );
		$this->assertSame( 977, $result['total_size'] );
		$this->assertSame( [ 7 ], \array_column( $result['segments'], 'id' ) );
	}

	/** Seed two newline-delimited packed records into logs/firehose.p0. */
	private function seed_two_records(): array {
		$dir = $this->tmp . '/logs/firehose.p0';
		\mkdir( $dir, 0755, true );
		$first                   = Message::new_message();
		$first[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$first[ Message::VALUE ] = 'first record 4194';
		$second                   = Message::new_message();
		$second[ Message::TYPE ]  = Message::TM_STRUCT;
		$second[ Message::VALUE ] = [ 'k' => 'second 977' ];
		$line1 = Message::packed( $first ) . "\n";
		$line2 = Message::packed( $second ) . "\n";
		\file_put_contents( "{$dir}/0.log", $line1 . $line2 );
		return [ $line1, $line2 ];
	}

	/**
	 * Seed `$sizes` records into logs/firehose.p0 segment 0, record `i`
	 * carrying a value of `$sizes[i]` bytes that names its index.
	 *
	 * @param list<int> $sizes Value byte counts.
	 * @return list<string> The packed lines, newline included.
	 */
	private function seed_sized_records( array $sizes ): array {
		$dir = $this->tmp . '/logs/firehose.p0';
		\mkdir( $dir, 0755, true );
		$lines = [];
		foreach ( $sizes as $i => $size ) {
			$m                   = Message::new_message();
			$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$m[ Message::VALUE ] = \str_pad( "rec-{$i}-", $size, 'x' );
			$lines[]             = Message::packed( $m ) . "\n";
		}
		\file_put_contents( "{$dir}/0.log", \implode( '', $lines ) );
		return $lines;
	}

	public function test_node_schema_declares_exactly_the_four_verbs(): void {
		$names = \array_column( Raw_Logs_CI_Node::node_schema()['commands'], 'name' );
		\sort( $names );
		$this->assertSame( [ 'dump_log', 'list_logs', 'read_block', 'read_message' ], $names );
		$this->assertNotEmpty( Raw_Logs_CI_Node::node_schema()['description'] );
	}

	public function test_read_block_stops_before_the_record_that_would_pass_a_mebibyte(): void {
		$lines = $this->seed_sized_records( [ 307211, 307213, 307217, 307219 ] );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start' ] );

		$this->assertSame( [ 'rec-0-', 'rec-1-', 'rec-2-' ], \array_map( static fn ( array $m ): string => \substr( $m[ Message::VALUE ], 0, 6 ), $result['messages'] ) );
		$this->assertSame( [ 'segment' => 0, 'offset' => \strlen( $lines[0] . $lines[1] . $lines[2] ) ], $result['cursor'], 'the cursor stands before the record left out' );
		$this->assertFalse( $result['at_eof'] );
	}

	public function test_read_block_returns_a_record_larger_than_the_block_alone(): void {
		$lines = $this->seed_sized_records( [ 2097169, 4194 ] );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', '0:0' ] );

		$this->assertCount( 1, $result['messages'] );
		$this->assertSame( 2097169, \strlen( $result['messages'][0][ Message::VALUE ] ) );
		$this->assertSame( [ 'segment' => 0, 'offset' => \strlen( $lines[0] ) ], $result['cursor'] );
	}

	public function test_read_block_reads_to_the_end_and_says_so(): void {
		[ $line1, $line2 ] = $this->seed_two_records();

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start' ] );

		$this->assertSame( [ 'first record 4194', [ 'k' => 'second 977' ] ], \array_column( $result['messages'], Message::VALUE ) );
		$this->assertSame( 'firehose.p0', $result['messages'][0][ Message::FROM ], 'stamped like a streamed row' );
		$this->assertSame( [ 'segment' => 0, 'offset' => \strlen( $line1 . $line2 ) ], $result['cursor'] );
		$this->assertTrue( $result['at_eof'] );
		$this->assertSame( 0, $result['unparseable_lines'] );
	}

	public function test_read_block_counts_the_lines_it_skipped(): void {
		[ $line1, $line2 ] = $this->seed_two_records();
		\file_put_contents( $this->tmp . '/logs/firehose.p0/0.log', $line1 . "torn-6113\n" . $line2 );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start' ] );

		$this->assertCount( 2, $result['messages'] );
		$this->assertSame( 1, $result['unparseable_lines'] );
		$this->assertSame( [ 'segment' => 0, 'offset' => \strlen( $line1 . "torn-6113\n" . $line2 ) ], $result['cursor'] );
	}

	public function test_read_block_charges_skipped_lines_to_the_budget(): void {
		$dir   = $this->tmp . '/logs/firehose.p0';
		\mkdir( $dir, 0755, true );
		$first = Message::new_message();
		$first[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$first[ Message::VALUE ] = 'lead-8821';
		$line1 = Message::packed( $first ) . "\n";
		$torn  = \str_repeat( 'x', 399999 ) . "\n";
		$tail  = $first;
		$tail[ Message::VALUE ] = 'after-4417';
		\file_put_contents( "{$dir}/0.log", $line1 . $torn . $torn . $torn . $torn . Message::packed( $tail ) . "\n" );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start' ] );

		$this->assertSame( [ 'lead-8821' ], \array_column( $result['messages'], Message::VALUE ) );
		$this->assertSame( 3, $result['unparseable_lines'], 'stopped once the walk passed a mebibyte' );
		$this->assertSame( [ 'segment' => 0, 'offset' => \strlen( $line1 ) + 3 * \strlen( $torn ) ], $result['cursor'] );
		$this->assertFalse( $result['at_eof'] );
	}

	public function test_read_block_charges_a_leading_skipped_run_to_the_budget(): void {
		$dir   = $this->tmp . '/logs/firehose.p0';
		\mkdir( $dir, 0755, true );
		$torn  = \str_repeat( 'x', 399999 ) . "\n";
		$tail  = Message::new_message();
		$tail[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$tail[ Message::VALUE ] = 'after-3306';
		\file_put_contents( "{$dir}/0.log", $torn . $torn . $torn . $torn . Message::packed( $tail ) . "\n" );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start' ] );

		$this->assertSame( [], $result['messages'], 'a corrupt head fills the block with no record' );
		$this->assertSame( 3, $result['unparseable_lines'] );
		$this->assertSame( [ 'segment' => 0, 'offset' => 3 * \strlen( $torn ) ], $result['cursor'] );
		$this->assertFalse( $result['at_eof'] );
	}

	/** Seed segment 1 with one record whose TIMESTAMP is `$stamp`, segment 0 aged to `$mtime`. */
	private function seed_next_segment( float $stamp, int $mtime ): void {
		$this->seed_two_records();
		$next                   = Message::new_message();
		$next[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$next[ Message::TIMESTAMP ] = $stamp;
		$next[ Message::VALUE ] = 'next segment';
		\file_put_contents( $this->tmp . '/logs/firehose.p0/1.log', Message::packed( $next ) . "\n" );
		\touch( $this->tmp . '/logs/firehose.p0/0.log', $mtime );
	}

	public function test_read_block_crosses_a_multi_writer_segment_whose_successor_is_old_enough(): void {
		Core::$now = 1700000103.3;
		$this->seed_next_segment( 1700000099.9, 1700000000 );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start', '--multi_writer=true' ] );

		$this->assertCount( 3, $result['messages'], 'a fresh reader crosses a segment whose successor is past the grace' );
	}

	public function test_read_block_holds_a_multi_writer_segment_whose_successor_is_young(): void {
		Core::$now = 1700000103.3;
		$this->seed_next_segment( 1700000102.9, 1700000000 );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start', '--multi_writer=true' ] );

		$this->assertCount( 2, $result['messages'] );
		$this->assertTrue( $result['at_eof'] );
	}

	public function test_read_block_holds_a_multi_writer_boundary(): void {
		[ $line1 ] = $this->seed_two_records();
		\file_put_contents( $this->tmp . '/logs/firehose.p0/1.log', $line1 );

		$held = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start', '--multi_writer=true' ] );

		$this->assertCount( 2, $held['messages'], 'a fresh segment 0 is not sealed yet' );
		$this->assertTrue( $held['at_eof'] );
		$this->assertSame( 0, $held['cursor']['segment'] );
	}

	public function test_read_block_seals_a_segment_for_a_single_writer(): void {
		[ $line1 ] = $this->seed_two_records();
		\file_put_contents( $this->tmp . '/logs/firehose.p0/1.log', $line1 );

		$plain = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'start' ] );

		$this->assertCount( 3, $plain['messages'], 'a single writer seals 0 when 1 appears' );
	}

	public function test_read_block_rejects_a_malformed_position(): void {
		$this->seed_two_records();

		$bad = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'firehose.p0', 'abc' ] );

		$this->assertSame( "read_block: invalid position (want <segment>:<offset>[:<length>], :<offset> on a file source, start, recent or end)\n", $bad );
	}

	public function test_read_block_refuses_an_unknown_log(): void {
		$this->seed_two_records();

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_block', [ 'kea-7713.p9', '0:0' ] );

		$this->assertSame( "unknown log: \"kea-7713.p9\"\n", $result );
	}

	public function test_read_message_refuses_an_unknown_log_instead_of_reading_another(): void {
		$this->seed_two_records();

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_message', [ 'kea-7713.p9', '0:0' ] );

		$this->assertSame( "unknown log: \"kea-7713.p9\"\n", $result );
	}

	public function test_read_message_refuses_an_empty_log_at_the_binder(): void {
		$this->seed_two_records();

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_message', [ '', '0:0' ] );

		$this->assertSame( "missing required argument: log\n", $result );
	}

	public function test_read_message_reads_a_registry_source(): void {
		$path = $this->tmp . '/php-errors-4194.log';
		\file_put_contents( $path, "PHP Notice: 977\nPHP Warning: 4194\n" );
		\Newspack_Nodes\Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_message', [ 'sources/php', 'start' ] );

		$this->assertSame( 'sources/php', $result['source'] );
		$this->assertSame( "PHP Notice: 977\n", $result['message'][ Message::VALUE ] );
		$this->assertSame( 16, $result['cursor']['offset'] );
	}

	public function test_read_message_returns_the_record_at_a_position(): void {
		[ $line1 ] = $this->seed_two_records();

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'read_message',
			[ 'firehose.p0', '0:0' ]
		);

		$this->assertSame( 'first record 4194', $result['message'][ Message::VALUE ] );
		// Stamped exactly like a streamed row: FROM + the ID breadcrumb.
		$this->assertSame( 'firehose.p0', $result['message'][ Message::FROM ] );
		$this->assertSame( '0:0:' . \strlen( $line1 ), $result['message'][ Message::ID ] );
		// The post-step cursor IS the next-record position.
		$this->assertSame(
			[
				'segment' => 0,
				'offset'  => \strlen( $line1 ),
			],
			$result['cursor']
		);
		$this->assertFalse( $result['at_eof'] );
	}

	/**
	 * Replay seeks with the magic 'start' token and Step reads at the SAME
	 * position, so the read verb must accept the seek transport's vocabulary.
	 * Rejecting it is why pause → Replay → Step did nothing.
	 */
	public function test_read_message_accepts_the_magic_start_position(): void {
		$this->seed_two_records();

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'read_message',
			[ 'firehose.p0', 'start' ]
		);

		$this->assertIsArray( $result, 'start must read, not error' );
		$this->assertSame( 'first record 4194', $result['message'][ Message::VALUE ] );
	}

	public function test_read_message_followup_position_reads_the_next_record_length_blind(): void {
		// offset + length steps to record two; a trailing :length is ignored.
		[ $line1 ] = $this->seed_two_records();

		$next = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'read_message',
			[ 'firehose.p0', '0:' . \strlen( $line1 ) . ':12345' ]
		);

		$this->assertSame( [ 'k' => 'second 977' ], $next['message'][ Message::VALUE ] );
	}

	public function test_read_message_rejects_a_malformed_position(): void {
		$this->seed_two_records();

		$bad = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'read_message',
			[ 'firehose.p0', 'abc' ]
		);

		$this->assertSame( "read_message: invalid position (want <segment>:<offset>[:<length>], :<offset> on a file source, start, recent or end)\n", $bad );
	}

	public function test_read_message_reads_a_grouped_deadletter_key(): void {
		$dir = $this->tmp . '/deadletter/job-worker.jobs.p0';
		\mkdir( $dir, 0755, true );
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'quarantined 41941';
		\file_put_contents( "{$dir}/7.log", Message::packed( $m ) . "\n" );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'read_message',
			[ 'deadletter/job-worker.jobs.p0', '7:0' ]
		);

		$this->assertSame( 'quarantined 41941', $result['message'][ Message::VALUE ] );
		$this->assertSame( 7, $result['cursor']['segment'] );
	}

	public function test_read_message_answers_no_record_as_a_result(): void {
		[ $line1, $line2 ] = $this->seed_two_records();
		$end               = \strlen( $line1 . $line2 );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'read_message',
			[ 'firehose.p0', "0:{$end}" ]
		);

		$this->assertSame(
			[
				'source'  => 'firehose.p0',
				'message' => null,
				'cursor'  => [ 'segment' => 0, 'offset' => $end ],
				'at_eof'  => true,
			],
			$result
		);
	}

	public function test_read_message_refuses_an_explicit_logs_prefix(): void {
		$this->seed_two_records();

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'read_message', [ 'logs/firehose.p0', '0:0' ] );

		$this->assertSame( "invalid subscription: logs/firehose.p0\n", $result );
	}

	public function test_dump_log_verb_reflects_seeded_segments(): void {
		// Seed a 128-byte segment in the flat concrete dir so the verb reports
		// non-zero size for that single dir.
		$seg_dir = $this->tmp . '/logs/firehose.p0';
		\mkdir( $seg_dir, 0755, true );
		\file_put_contents( "{$seg_dir}/0.log", \str_repeat( 'x', 128 ) );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'dump_log',
			'firehose.p0'
		);

		$this->assertSame( 128, $result['total_size'] );
		$this->assertSame( 1, $result['segment_count'] );
		$this->assertCount( 1, $result['segments'] );
		$this->assertSame( 128, $result['segments'][0]['size'] );
	}

	public function test_dump_log_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'dump_log',
			'firehose.p0'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}
}

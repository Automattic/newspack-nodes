<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;

#[CoversClass( Consumer_Node::class )]
class ConsumerTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns source_dir + an offsetlog_base_dir token
	 * (which the override normalizes into the derived offsetlog_dir +
	 * materializes the offsetlog Partition).
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p2 {$this->tmp}/offsets/r/p2" );
		$ref = new \ReflectionClass( $c );
		$this->assertSame( "{$this->tmp}/data/p2",      $ref->getProperty( 'source_dir' )->getValue( $c ) );
		$this->assertSame( "{$this->tmp}/offsets/r/p2", $ref->getProperty( 'offsetlog_dir' )->getValue( $c ) );
		$this->assertInstanceOf( Partition_Node::class, $ref->getProperty( 'offsetlog' )->getValue( $c ) );
	}

	public function test_seam_methods_return_consumer_defaults(): void {
		$probe = new class() extends \Newspack_Nodes\Consumer_Node {
			public function probe_make_source(): \Newspack_Nodes\Partition_Node { return $this->make_source(); }
			public function probe_resolve_args(): array { return $this->resolve_args(); }
			public function probe_default_offset(): ?string { return $this->default_offset(); }
		};
		$probe->arguments( "{$this->tmp}/src {$this->tmp}/off" );

		$source = $probe->probe_make_source();
		$this->assertInstanceOf( \Newspack_Nodes\Partition_Node::class, $source );
		$this->assertNotInstanceOf( \Newspack_Nodes\Log_Node::class, $source, 'Consumer source is a Partition, not a Log' );
		$this->assertSame( [ "{$this->tmp}/src", "{$this->tmp}/off" ], $probe->probe_resolve_args() );
		$this->assertNull( $probe->probe_default_offset(), 'Consumer starts at 0:0 — no default-offset seek' );
	}

	/**
	 * Empty `offsetlog_base_dir` token leaves the offsetlog Partition null
	 * (ephemeral readers skip durable cursors).
	 */
	public function test_arguments_setter_with_empty_offsetlog_skips_offsetlog_partition(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$ref = new \ReflectionClass( $c );
		$this->assertNull( $ref->getProperty( 'offsetlog' )->getValue( $c ) );
		$this->assertSame( '', $ref->getProperty( 'offsetlog_dir' )->getValue( $c ) );
	}

	/**
	 * Schema default for offsetlog_base_dir is '' (not '<config:...>') — so
	 * calling arguments() with only the two required tokens leaves the optional
	 * offsetlog at '' rather than a placeholder string.
	 */
	public function test_arguments_setter_applies_empty_default_for_missing_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0" );
		$ref = new \ReflectionClass( $c );
		$this->assertSame( '', $ref->getProperty( 'offsetlog_dir' )->getValue( $c ) );
		$this->assertNull( $ref->getProperty( 'offsetlog' )->getValue( $c ) );
	}

	public function test_poll_accumulates_bytes_read_on_consumer(): void {
		// bytes_read on Consumer should reflect total bytes pulled from its
		// source partition via poll(). The Partition itself ALSO tracks
		// its own bytes_read (sourced from read_at calls), but the Consumer
		// is the node operators see in `stats` so it needs to surface the
		// volume too.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$message_a  = $this->produce( 'first' );
		$source->fill( $message_a );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$packed_size = \strlen( Message::packed( $message_a ) ) + 1; // trailing \n
		$this->assertSame( $packed_size, $c->bytes_read() );
	}

	public function test_probe_stats_is_a_lean_positional_snapshot(): void {
		// probe_stats() is the raw snapshot TopicProbe reads from OUTSIDE the
		// Consumer — the POSITIONAL Probe_Record: SOURCE (partition tailed) +
		// READER (offsetlog dir basename) + cursor + partition END (last seg + size)
		// + DISTANCE (backlog) + MSGS. No derived/extra fields.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$first  = $this->produce( 'first' );
		$second = $this->produce( 'second' );
		$source->fill( $first );
		$source->fill( $second );
		$source->flush();

		$c = new Consumer_Node();
		$c->name( 'firehose' );
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/firehose.job-router.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$stats = $c->probe_stats();
		$this->assertCount( 9, $stats, 'lean positional record' );
		// READER = offsetlog dir basename; SOURCE = partition tailed (its basename).
		$this->assertSame( 'firehose.job-router.p0', $stats[ Probe_Record::READER ] );
		$this->assertSame( 'p0', $stats[ Probe_Record::SOURCE ] );
		$this->assertSame( 0, $stats[ Probe_Record::CURSOR_SEG ] );
		$this->assertGreaterThan( 0, $stats[ Probe_Record::CURSOR_OFF ] );
		$this->assertSame( 0, $stats[ Probe_Record::DISTANCE ], 'caught up after pump' );
		// Partition END = the one segment + its (non-zero) size.
		$this->assertSame( 0, $stats[ Probe_Record::END_SEG ] );
		$this->assertGreaterThan( 0, $stats[ Probe_Record::END_SIZE ] );
		$this->assertSame( 2, $stats[ Probe_Record::MSGS ] );
		// END_BYTES = the partition's total bytes; caught up → equals what we consumed.
		$this->assertSame( $stats[ Probe_Record::END_SIZE ], $stats[ Probe_Record::END_BYTES ] );
	}

	public function test_probe_stats_round_trips_through_cli_consumer_rows(): void {
		// Pin the writer→reader contract by index: the exact positions probe_stats()
		// WRITES are the positions CLI::consumer_rows() READS back off the log.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$first = $this->produce( 'first' );
		$source->fill( $first );
		$source->flush();

		$c = new Consumer_Node();
		$c->name( 'firehose' );
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/firehose.job-router.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$stats = $c->probe_stats();

		// Write the record exactly as TopicProbe would (positional VALUE), read back.
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		\mkdir( $dir, 0755, true );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $stats;
		\file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n" );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows();
		$this->assertCount( 1, $rows );
		$row = $rows[0];
		$this->assertSame( $stats[ Probe_Record::READER ], $row['reader'] );
		$this->assertSame( $stats[ Probe_Record::SOURCE ], $row['source'] );
		$this->assertSame( $stats[ Probe_Record::CURSOR_SEG ], $row['cursor_seg'] );
		$this->assertSame( $stats[ Probe_Record::CURSOR_OFF ], $row['cursor_off'] );
		$this->assertSame( $stats[ Probe_Record::END_SEG ], $row['end_seg'] );
		$this->assertSame( $stats[ Probe_Record::END_SIZE ], $row['end_size'] );
		$this->assertSame( $stats[ Probe_Record::DISTANCE ], $row['distance'] );
		$this->assertSame( $stats[ Probe_Record::MSGS ], $row['msgs'] );
		$this->assertSame( 0, $row['partition'] );
	}

	public function test_poll_emits_line_for_each_new_log_entry(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );

		$this->assertCount( 2, $capture->captured );
		$this->assertSame( 'first',  $capture->captured[0][ Message::VALUE ] );
		$this->assertSame( 'second', $capture->captured[1][ Message::VALUE ] );
	}

	/**
	 * Build a TM_BYTESTREAM message and fill the Partition. Partition::fill
	 * packs via Message::packed and appends the bytes; Consumer auto-unpacks
	 * on the read side. Tests use this to simulate real producer flow.
	 */
	private function produce_line( Partition_Node $partition, string $value ): void {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = microtime( true );
		$message[ Message::VALUE ]     = $value;
		$partition->fill( $message );
		// Partition::fill batches in memory now — force on-disk visibility
		// so the Consumer's poll() picks up the bytes synchronously.
		$partition->flush();
	}

	public function test_poll_does_not_re_emit_old_lines_on_second_call(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );
		$this->assertCount( 1, $capture->captured );

		$this->pump_consumer( $c );
		$this->assertCount( 1, $capture->captured );

		$this->produce_line( $source, 'second' );
		$this->pump_consumer( $c );
		$this->assertCount( 2, $capture->captured );
	}

	public function test_line_mode_emits_each_entry_exactly_once_in_order(): void {
		// Line mode advances cursor_off per emitted line; if it doesn't, the buffer
		// chop and cursor drift apart and get_batch re-reads already-emitted bytes
		// (re-emitting whole lines, or mis-aligning a partial into unparseable garbage).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );
		$this->produce_line( $source, 'c' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->set_line_mode( true );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );

		$values = \array_map( static fn ( array $m ): mixed => $m[ Message::VALUE ], $capture->captured );
		$this->assertSame( [ 'a', 'b', 'c' ], $values );
	}

	public function test_line_mode_emits_at_most_one_entry_per_poll(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->set_line_mode( true );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		// First poll only loads the read block; then exactly one entry per poll.
		$c->poll();
		$this->assertCount( 0, $capture->captured, 'first poll loads the buffer, emits nothing' );
		$c->poll();
		$this->assertCount( 1, $capture->captured, 'one entry per poll' );
		$c->poll();
		$this->assertCount( 2, $capture->captured );
	}

	public function test_line_mode_emits_each_entry_exactly_once_across_segment_boundaries(): void {
		// Tiny segments force a roll per entry, so line mode drains across both
		// segment boundaries and fresh get_batch reads — the path where a cursor that
		// drifts from the buffer re-reads or mis-aligns into unparseable garbage.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 32 4 86400" );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );
		$this->assertGreaterThanOrEqual( 2, \count( $source->get_segments( true ) ), 'need multiple segments' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->set_line_mode( true );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );

		$values = \array_map( static fn ( array $m ): mixed => $m[ Message::VALUE ], $capture->captured );
		$this->assertSame(
			[ \str_repeat( 'a', 30 ), \str_repeat( 'b', 30 ), \str_repeat( 'c', 30 ) ],
			$values
		);
	}

	public function test_checkpoint_records_target_and_worker_type(): void {
		// Dashboard needs per-Consumer metadata so it can render rows
		// like "worker X · consumer Y · target Z" instead of the static
		// hardcoded WORKER_INPUTS map. Worker_type comes from the env
		// var the supervisor sets; target is what Node::target() holds.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$_SERVER['NEWSPACK_NODES_WORKER_TYPE'] = 'firehose-workers';

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content = (string) file_get_contents( $offsetlog_path );
		$message     = Message::unpacked( rtrim( $content, "\n" ) );
		$entry   = $message[ Message::VALUE ];

		$this->assertSame( 'firehose-workers', $entry['worker_type'] ?? null );
		$this->assertSame( 'firehose:tee',     $entry['target']      ?? null );
		$this->assertSame( 'firehose:consumer', $entry['name']       ?? null );
		// The stored record carries the producing Consumer's identity in FROM.
		$this->assertSame( 'firehose:consumer', $message[ Message::FROM ] );
		// `targets` resolves downstream; with no node registered for
		// firehose:tee, the row surfaces the name with an empty class.
		$this->assertSame(
			[ [ 'name' => 'firehose:tee', 'class' => '' ] ],
			$entry['targets'] ?? null
		);

		unset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
	}

	public function test_checkpoint_records_source_log_basename(): void {
		// Two readers can tail the SAME log under distinct offset-dir names
		// (firehose vs firehose.job-router) so each keeps a separate cursor.
		// The dashboard must label both with the REAL log — so the checkpoint
		// records the source log basename, not just the offset-dir name.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/firehose.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/firehose.p0 {$this->tmp}/offsets/firehose.job-router.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/firehose.job-router.p0/0.log";
		$content        = (string) file_get_contents( $offsetlog_path );
		$message            = Message::unpacked( rtrim( $content, "\n" ) );
		$entry          = $message[ Message::VALUE ];

		$this->assertSame( 'firehose.p0', $entry['source_log'] ?? null );
	}

	public function test_checkpoint_writes_offsetlog_entry(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint();

		// Offsetlog stores packed Tachikoma messages whose VALUE is the
		// {seg, off, ts} struct. The packed line should mention "seg" and "off".
		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$this->assertTrue( file_exists( $offsetlog_path ), 'Offsetlog must exist after checkpoint' );
		$content = (string) file_get_contents( $offsetlog_path );
		$message     = Message::unpacked( rtrim( $content, "\n" ) );
		$entry   = $message[ Message::VALUE ];
		$this->assertSame( 0, $entry['seg'] );
		$this->assertGreaterThan( 0, $entry['off'] );
	}

	public function test_fire_checkpoints_at_most_once_per_30s(): void {
		// The offsetlog is crash-resume only (not a position source — TopicProbe is),
		// so fire() checkpoints at most every CHECKPOINT_INTERVAL_S (30s), not every
		// poll. Each checkpoint appends one offsetlog entry, so entry-count == checkpoints.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$c = new class() extends Consumer_Node {
			public function probe_fire(): void {
				$this->fire();
			}
		};
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		// One checkpoint = one segment (segment_size=1 keyframe timeline), so count
		// records across ALL segment files, not just 0.log.
		$entries = fn (): int => $this->count_offsetlog_records( "{$this->tmp}/offsets/r/p0" );

		Core::$now = 1000.0;
		$c->probe_fire(); // first fire → checkpoint
		$first = $entries();
		$this->assertGreaterThan( 0, $first );

		// New data → the +15s fire's poll ADVANCES the cursor, but the checkpoint
		// is still gated below 30s (the point: cursor moves, offsetlog doesn't).
		$this->produce_line( $source, 'world' );
		Core::$now = 1015.0;
		$c->probe_fire();
		$this->assertSame( $first, $entries(), 'cursor advanced but no checkpoint before 30s' );

		Core::$now = 1030.0;
		$c->probe_fire(); // 30s elapsed → checkpoint the advanced cursor
		$this->assertSame( $first + 1, $entries(), 'checkpoint at the 30s boundary' );
	}

	public function test_checkpoint_co_commits_snapshot_node_state_and_restores_it(): void {
		// Tachikoma snapshot pattern: the Consumer co-commits {offset, cache} as ONE
		// offsetlog record, so the read offset and the named node's state stay
		// aligned across a respawn. A >4KB cache also proves set_snapshot_node lifts
		// the offsetlog's PIPE_BUF cap (void_warranty) — the worker is its sole writer.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$node       = new Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'in_flight' => [ 'r1' => [ 'pad' => \str_repeat( 'x', 5000 ) ] ] ];

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$c->set_snapshot_node( 'request-builder' );
		$this->pump_consumer( $c );
		$c->checkpoint();

		// Old worker process dies; the offsetlog file (with the cache) persists.
		Core::reset();

		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c2->name( 'firehose:consumer' );
		$c2->sink( new Capture_Sink_Node() );
		// Order-independence (the bug this fixes): the snapshot node is named BEFORE
		// it is built, exactly as a per-node-serialized topology emits it. Recording
		// the name must NOT try to restore yet — there is no node to restore into.
		$c2->set_snapshot_node( 'request-builder' );
		$node2 = new Snapshot_Probe();
		$node2->name( 'request-builder' );

		// Construction + naming do no restore — state is still empty.
		$this->assertSame( [], $node2->state, 'restore must be deferred, not run at set_snapshot_node time' );

		// The first poll (poll_init) loads the durable cursor and restores the
		// snapshot into the by-then-built node — no warning, no discarded cache.
		$this->pump_consumer( $c2 );

		$this->assertSame(
			[ 'in_flight' => [ 'r1' => [ 'pad' => \str_repeat( 'x', 5000 ) ] ] ],
			$node2->state,
			'the snapshot node must resume the cache the prior worker committed with the offset'
		);
	}

	public function test_restart_resumes_from_last_checkpoint(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap1 = new Capture_Sink_Node();
		$c1->sink( $cap1 );
		$this->pump_consumer( $c1 );
		$c1->checkpoint();
		unset( $c1 );

		$this->produce_line( $source, 'second' );

		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap2 = new Capture_Sink_Node();
		$c2->sink( $cap2 );
		$this->pump_consumer( $c2 );

		$this->assertCount( 1, $cap2->captured );
		$this->assertSame( 'second', $cap2->captured[0][ Message::VALUE ] );
	}

	public function test_has_checkpoint_false_without_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$this->assertFalse( $c->has_checkpoint() );
	}

	public function test_has_checkpoint_false_when_offsetlog_has_no_prior_entry(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$this->assertFalse( $c->has_checkpoint() );
	}

	public function test_has_checkpoint_true_after_resuming_from_offsetlog(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c1->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c1 );
		$c1->checkpoint();
		unset( $c1 );

		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c2->sink( new Capture_Sink_Node() );
		// has_checkpoint is meaningful only after the first poll seeds the cursor
		// from the offsetlog (construction does no I/O).
		$c2->poll();
		$this->assertTrue( $c2->has_checkpoint() );
	}

	// ============================================================================
	// Hardening: cross-poll partial-line accumulation.
	// ============================================================================

	public function test_partial_line_carries_across_polls(): void {
		// Simulate a writer that writes a single packed line in two halves.
		// Use raw fwrite to bypass Partition's atomic-line semantics.
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::VALUE ]     = 'first';
		$packed                    = Message::packed( $message ) . "\n";
		$mid                       = (int) ( strlen( $packed ) / 2 );
		$half1                     = substr( $packed, 0, $mid );
		$half2                     = substr( $packed, $mid );

		mkdir( "{$this->tmp}/data/p0", 0755, true );
		file_put_contents( "{$this->tmp}/data/p0/0.log", $half1 );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$c->poll();
		// No complete line yet — should emit nothing.
		$this->assertCount( 0, $cap->captured, 'partial line must NOT be emitted on first poll' );

		// Append the rest of the line.
		file_put_contents( "{$this->tmp}/data/p0/0.log", $half2, FILE_APPEND );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured, 'completed line must emit once fully written' );
		$this->assertSame( 'first', $cap->captured[0][ Message::VALUE ] );
		// Cursor should be at start of segment 0.
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ] );
	}

	public function test_partial_line_does_not_double_emit_bytes(): void {
		// Writer writes a packed line 1 byte at a time across multiple polls.
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::VALUE ]     = 'hello';
		$packed                    = Message::packed( $message ) . "\n";

		mkdir( "{$this->tmp}/data/p0", 0755, true );
		file_put_contents( "{$this->tmp}/data/p0/0.log", '' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		for ( $i = 0; $i < strlen( $packed ); $i++ ) {
			file_put_contents( "{$this->tmp}/data/p0/0.log", $packed[ $i ], FILE_APPEND );
			$c->poll();
		}
		$this->pump_consumer( $c ); // drain the final block (drain precedes get_batch each poll).

		$this->assertCount( 1, $cap->captured, 'each byte must accumulate into single emit' );
		$this->assertSame( 'hello', $cap->captured[0][ Message::VALUE ] );
	}

	// ============================================================================
	// Hardening: MAX_LINE_BUFFER_SIZE DoS guard.
	// ============================================================================

	public function test_MAX_LINE_BUFFER_SIZE_constant_defined(): void {
		$this->assertSame( 33554432, Consumer_Node::MAX_LINE_BUFFER_SIZE );
	}

	public function test_oversized_line_buffer_is_bounded_by_guard(): void {
		// Defensive test: write a multi-MB stream with no newlines and verify the read
		// buffer stays bounded by MAX_LINE_BUFFER_SIZE. Skip on tight memory_limit since
		// this needs ~20MB of resident memory across polls.
		$limit = ini_get( 'memory_limit' );
		if ( $limit && '-1' !== $limit ) {
			$mem_bytes = (int) preg_replace_callback(
				'/(\d+)([KMG]?)/i',
				static function ( $m ) {
					$mult = [ '' => 1, 'K' => 1024, 'M' => 1048576, 'G' => 1073741824 ];
					return (int) $m[1] * $mult[ strtoupper( $m[2] ) ];
				},
				$limit
			);
			if ( $mem_bytes > 0 && $mem_bytes < 192 * 1048576 ) {
				$this->markTestSkipped( 'memory_limit too low for 20MB buffer test (need >= 192M)' );
				return;
			}
		}

		mkdir( "{$this->tmp}/data/p0", 0755, true );
		// Stream 21MB (no newlines) via per-MB chunks to keep per-allocation small.
		$fh    = fopen( "{$this->tmp}/data/p0/0.log", 'wb' );
		$chunk = str_repeat( 'x', 1048576 );
		for ( $i = 0; $i < 21; ++$i ) {
			fwrite( $fh, $chunk );
		}
		fclose( $fh );
		unset( $chunk );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Drain to EOF. Each poll reads one READ_BLOCK_BYTES block into the buffer;
		// once it crosses 20MB with no newline, the discard branch MUST fire.
		$this->pump_consumer( $c );

		$ref = new \ReflectionClass( $c );
		$rem_prop = $ref->getProperty( 'buffer' );
		$rem_prop->setAccessible( true );
		$rem_after = $rem_prop->getValue( $c );
		$this->assertLessThanOrEqual(
			Consumer_Node::MAX_LINE_BUFFER_SIZE,
			\strlen( $rem_after ),
			'buffer must never exceed MAX_LINE_BUFFER_SIZE'
		);
		// No newlines means no emission, regardless of how much was discarded.
		$this->assertCount( 0, $cap->captured );
	}

	// ============================================================================
	// Hardening: next_offset 'end' (tail seek for fresh-tail SSE readers).
	// ============================================================================

	public function test_next_offset_end_seeks_to_tail(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'old1' );
		$this->produce_line( $source, 'old2' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$c->next_offset( 'end' ); // Skip past existing data.
		$c->poll();
		$this->assertCount( 0, $cap->captured, 'end-seek must skip pre-existing lines' );

		$this->produce_line( $source, 'new1' );
		$this->pump_consumer( $c );
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'new1', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_next_offset_start_resets_to_zero(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'alpha' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$c->next_offset( 'end' );
		$c->next_offset( 'start' );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'alpha', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_next_offset_recent_picks_second_to_last_segment(): void {
		// Force several segments.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 32 4 86400" );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$count = count( $segments );
		$this->assertGreaterThanOrEqual( 2, $count );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'recent' );

		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$expected = $segments[ $count - 2 ]['id'];
		$this->assertSame( $expected, $seg_prop->getValue( $c ) );
	}

	public function test_empty_offsetlog_dir_skips_offsetlog(): void {
		// cli sessions and other ephemeral readers pass '' for offsetlog dir
		// to skip the offsetlog entirely — no per-session directories under
		// offsets/, no checkpoint persistence, just tail.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'hello', $cap->captured[0][ Message::VALUE ] );

		// checkpoint() must be a no-op in this mode — no offsetlog directory
		// should appear underneath $this->tmp.
		$c->checkpoint();
		$this->assertFalse( is_dir( "{$this->tmp}/offsets" ), 'no offsetlog dir created with empty offsetlog_base_dir' );
	}

	public function test_next_offset_explicit_array_position(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( [ 'seg' => 5, 'off' => 100 ] );

		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );
		$this->assertSame( 5, $seg_prop->getValue( $c ) );
		$this->assertSame( 100, $off_prop->getValue( $c ) );
	}

	public function test_next_offset_array_clamps_negative_off_to_zero(): void {
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		// Spec: negative offsets must be clamped to 0 (max(0, ...)).
		$c->next_offset( [ 'seg' => 2, 'off' => -42 ] );
		$this->assertSame( 0, $off->getValue( $c ), 'negative off must be clamped to 0' );
	}

	// ============================================================================
	// poll() — drain branches not yet covered.
	// ============================================================================

	public function test_poll_recovers_when_cursor_segment_was_deleted(): void {
		// Cursor parked on a segment id that no longer exists — poll() must
		// recover by rewinding to the oldest available segment and reading from 0.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 32 4 86400" );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertNotEmpty( $segments );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		// Force cursor into an id that does NOT appear in the segment list.
		$max_id = (int) end( $segments )['id'];
		$seg->setValue( $c, $max_id + 50 );
		$off->setValue( $c, 999 );

		$this->pump_consumer( $c );

		// After rewind + drain, cursor lands on the NEWEST segment (poll stepped
		// from oldest forward through all segments, one per tick).
		$this->assertSame( $max_id, $seg->getValue( $c ), 'cursor must end on newest segment after full drain' );
		// All lines should have been emitted: 3 produce_line calls = 3 lines.
		$this->assertSame( 3, count( $cap->captured ), 'rewind must let us read all existing data' );
	}

	public function test_poll_recovers_when_cursor_segment_was_recreated_smaller(): void {
		// A retention sweep can delete EVERY segment; the writer then restarts
		// numbering at 0 while the durable offsetlog survives. The restored
		// cursor sits past EOF of the recreated (smaller) segment — poll() must
		// rewind to the segment start instead of waiting forever for the file
		// to grow back past the stale offset.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'after-wipe' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Stale checkpoint from before the wipe: same segment id (0), offset
		// far past the recreated segment's size, plus a leftover partial line.
		$stale_off = 5774576; // any value past the recreated segment's size
		$ref       = new \ReflectionClass( $c );
		$off       = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$off->setValue( $c, $stale_off );
		$rem = $ref->getProperty( 'buffer' );
		$rem->setAccessible( true );
		$rem->setValue( $c, 'stale-partial' );

		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured, 'cursor past EOF of an existing segment must rewind and drain' );
		$this->assertSame( 'after-wipe', $cap->captured[0][ Message::VALUE ] );
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ], 'rewind must restart at segment offset 0' );
	}

	public function test_handle_request_GET_LAG_reports_replay_when_cursor_past_eof(): void {
		// Companion to the recreated-segment recovery: a cursor past EOF means
		// the whole segment is pending replay. GET_LAG must say so instead of
		// clamping to bytes_behind=0 / caught_up=true (which masked a wedged
		// consumer as healthy).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'after-wipe' );
		$segment_size = (int) $source->get_segments( true )[0]['size'];

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Stale cursor past EOF, plus a stale partial line LONGER than the
		// recreated segment — the old remainder subtraction would clamp
		// bytes_behind back to 0 and re-mask the wedge.
		$stale_off = 5774576; // any value past the recreated segment's size
		$ref       = new \ReflectionClass( $c );
		$off       = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$off->setValue( $c, $stale_off );
		$rem = $ref->getProperty( 'buffer' );
		$rem->setAccessible( true );
		$rem->setValue( $c, str_repeat( 'x', $segment_size + 1 ) );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertSame( $segment_size, $data['bytes_behind'], 'cursor past EOF replays the whole segment' );
		$this->assertFalse( $data['caught_up'], 'a wedged cursor must not report caught_up' );
	}

	public function test_handle_request_GET_LAG_reports_pending_segments_when_cursor_segment_deleted(): void {
		// Deleted-cursor-segment twin: poll() will rewind to the oldest segment
		// and replay everything, so GET_LAG must report every segment as
		// pending — not skip them all because their ids sit below the cursor.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'after-wipe' );
		$segment_size = (int) $source->get_segments( true )[0]['size'];

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$seg->setValue( $c, 84 ); // checkpointed segment no longer exists

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertSame( $segment_size, $data['bytes_behind'], 'rewind to oldest segment replays everything' );
		$this->assertFalse( $data['caught_up'], 'a cursor on a deleted segment must not report caught_up' );
	}

	public function test_poll_advances_across_segment_boundary(): void {
		// Multi-segment drain: a single poll spanning into a new segment must
		// reset cursor_off to 0 when it crosses the boundary.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 32 4 86400" );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ), 'need multiple segments' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		// Should have read every line in every segment.
		$this->assertSame( 3, count( $cap->captured ) );
		$values = array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
		$this->assertSame(
			[ str_repeat( 'a', 30 ), str_repeat( 'b', 30 ), str_repeat( 'c', 30 ) ],
			$values,
			'every line across segment boundaries must emit in order'
		);

		// Cursor should be parked on the newest segment.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$this->assertSame( (int) end( $segments )['id'], $seg->getValue( $c ) );
	}

	public function test_poll_stamps_message_FROM_with_consumer_name(): void {
		// FROM-stamping is a required convention — every emitted message must
		// have the Consumer's name stamped onto FROM so downstream nodes can
		// reply via TO=FROM.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hi' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'my-consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'my-consumer', $cap->captured[0][ Message::FROM ] );
	}

	public function test_poll_stamp_override_replaces_name_in_FROM(): void {
		// set_stamp_as overrides the FROM stamp — used by the worker's IPC
		// input Consumer to stamp as the OUTPUT partition's name (`_repl`).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'real-name' );
		$c->set_stamp_as( '_repl' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( '_repl', $cap->captured[0][ Message::FROM ], 'override must replace name in FROM' );
	}

	public function test_poll_emitted_ID_is_seg_colon_offset(): void {
		// Each emitted message's ID = "{seg}:{abs_offset}" — the offsetlog
		// uses this to checkpoint by segment+offset. ID (not KEY) because KEY
		// is the producer's routing key (rid for firehose, handler for
		// jobintake) and Consumer must preserve it for downstream routing.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 2, $cap->captured );
		// First line lands at offset 0 within segment 0.
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ] );
		// Second line lands AFTER the first packed line + newline.
		[ $seg2, $off2 ] = explode( ':', $cap->captured[1][ Message::ID ] );
		$this->assertSame( '0', $seg2 );
		$this->assertGreaterThan( 0, (int) $off2, 'second line offset must be past first' );
	}

	public function test_poll_preserves_producer_KEY(): void {
		// Consumer MUST NOT overwrite the producer's KEY. KEY is the routing
		// key — rid for firehose entries, handler for jobintake. Overwriting
		// it to seg:offset (as Consumer used to do) breaks RequestBuilder's
		// rid grouping and any multi-partition queue keyed on handler.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::KEY ]       = 'producer-key-abc123';
		$message[ Message::VALUE ]     = 'hello';
		$source->fill( $message );
		$source->flush();

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'producer-key-abc123', $cap->captured[0][ Message::KEY ] );
		// Position breadcrumb lands on ID alongside.
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ] );
	}

	public function test_poll_overwrites_existing_TO_with_target(): void {
		// Consumer forces TO = its target on every emitted line, OVERWRITING any
		// TO the stored message already carried (forward_line()). This is unlike
		// plain Node, which stamps TO only when it's empty (see the companion
		// test below). `wp nodes cli` relies on the distinction: it routes the
		// shared output-IPC partition through a plain Node, NOT a Consumer, so
		// each reply keeps its own TO and the Dumper's per-PID to_filter can drop
		// other sessions' traffic — a Consumer here would rewrite every reply's
		// TO to _output and dump all sessions into the REPL.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::TO ]        = '_sse/browser-99';
		$message[ Message::VALUE ]     = 'reply';
		$source->fill( $message );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->target( Node_Names::OUTPUT );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame(
			Node_Names::OUTPUT,
			$cap->captured[0][ Message::TO ],
			'Consumer must overwrite an already-set TO with its target'
		);
	}

	public function test_plain_node_preserves_existing_TO_when_target_set(): void {
		// The soft-route contrast that makes the cli fix work: a plain Node with
		// a target leaves a non-empty TO untouched (stamps only when TO is empty).
		$node = new Node();
		$node->target( Node_Names::OUTPUT );
		$cap = new Capture_Sink_Node();
		$node->sink( $cap );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$message[ Message::TO ]   = '_sse/browser-99';
		$node->fill( $message );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame(
			'_sse/browser-99',
			$cap->captured[0][ Message::TO ],
			'plain Node must NOT overwrite an already-set TO'
		);
	}

	// ============================================================================
	// load_offsetlog() — corrupt / malformed checkpoint entries.
	// ============================================================================

	public function test_load_offsetlog_ignores_malformed_value_field(): void {
		// Manually write a packed Message whose VALUE is NOT the expected
		// {seg, off} struct. load_offsetlog must NOT seed the cursor from it
		// (the if-is_array+isset gate at line 153 must reject it).
		mkdir( "{$this->tmp}/offsets/r/p0", 0755, true );

		// Message with VALUE = string "garbage" (not an array with seg/off).
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::VALUE ]     = 'garbage';
		file_put_contents( "{$this->tmp}/offsets/r/p0/0.log", Message::packed( $message ) . "\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );

		// Cursor must remain at the constructor default (0/0) when the offsetlog
		// entry's VALUE doesn't match the expected schema.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
	}

	public function test_load_offsetlog_skips_when_only_blank_lines(): void {
		// A segment that contains only newlines (no JSON-encoded packed message)
		// must be ignored — array_filter strips them and load_offsetlog returns
		// without seeding the cursor.
		mkdir( "{$this->tmp}/offsets/r/p0", 0755, true );
		file_put_contents( "{$this->tmp}/offsets/r/p0/0.log", "\n\n\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
	}

	// ============================================================================
	// checkpoint() — skip-when-unchanged branch.
	// ============================================================================

	public function test_checkpoint_skips_when_cursor_has_not_advanced(): void {
		// Spec: "Skip if cursor hasn't advanced since the last commit — the
		// saved entry is still the truth, no point appending a duplicate every tick."
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$path  = "{$this->tmp}/offsets/r/p0/0.log";
		$size1 = filesize( $path );

		// Second checkpoint with no cursor advancement must NOT append.
		$c->checkpoint();
		clearstatcache( true, $path );
		$size2 = filesize( $path );

		$this->assertSame( $size1, $size2, 'duplicate checkpoint must be skipped' );
	}

	public function test_checkpoint_appends_when_cursor_has_advanced(): void {
		// Inverse of the skip test: when cursor advances, a new entry MUST land.
		// The offsetlog is a keyframe timeline (segment_size=1 → one commit per
		// segment), so count total records across ALL segments rather than the
		// growth of a single 0.log file.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$count1 = $this->count_offsetlog_records( "{$this->tmp}/offsets/r/p0" );

		$this->produce_line( $source, 'second' );
		$c->poll();
		$c->checkpoint();
		$count2 = $this->count_offsetlog_records( "{$this->tmp}/offsets/r/p0" );

		$this->assertGreaterThan( $count1, $count2, 'cursor advancement must add a new offsetlog entry' );
	}

	/** Total non-blank offsetlog records across every segment file under $dir. */
	private function count_offsetlog_records( string $dir ): int {
		$total = 0;
		foreach ( \glob( "{$dir}/*.log" ) as $path ) {
			$total += \count( \array_filter( \explode( "\n", (string) \file_get_contents( $path ) ) ) );
		}
		return $total;
	}

	// ============================================================================
	// fire() — Timer hook (protected). Verifies poll() and conditional
	// checkpoint() run; timer is re-armed.
	// ============================================================================

	public function test_fire_polls_source_and_emits_messages(): void {
		// fire() is the Timer hook. It must call poll() so new bytes get drained.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'fired' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Invoke protected fire() via reflection. Each fire() drains the prior
		// block then reads one more, so the first fire reads 'fired' into the
		// buffer and the second drains it.
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );
		$fire->invoke( $c );

		$this->assertCount( 1, $cap->captured, 'fire() must drain via poll()' );
		$this->assertSame( 'fired', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_fire_writes_first_checkpoint_on_initial_call(): void {
		// On the FIRST fire(), last_checkpoint=0 so (now - 0) >= 1 always
		// holds — checkpoint() must run (provided the cursor advanced).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'cp' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$ref = new \ReflectionClass( $c );

		Core::$now = \microtime(true); // Ensure now is a real wall-clock value.

		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertFileExists(
			"{$this->tmp}/offsets/r/p0/0.log",
			'fire() with stale last_checkpoint must invoke checkpoint()'
		);

		// last_checkpoint should now be set to the current wall-clock time.
		$last = $ref->getProperty( 'last_checkpoint' );
		$last->setAccessible( true );
		$this->assertGreaterThan( 0.0, $last->getValue( $c ) );
	}

	public function test_fire_skips_checkpoint_when_within_interval(): void {
		// Spec: "Persist cursor every CHECKPOINT_INTERVAL_S so a respawning
		// worker resumes from the last commit." Within that interval, fire()
		// must NOT call checkpoint() — even if data was polled.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->sink( new Capture_Sink_Node() );
		$ref = new \ReflectionClass( $c );

		// Pre-set last_checkpoint to "right now" so the interval gate fails.
		Core::$now = \microtime(true);
		$last = $ref->getProperty( 'last_checkpoint' );
		$last->setAccessible( true );
		$last->setValue( $c, Core::$now );

		// Pre-set checkpoint_seg/off to match cursor so checkpoint() would skip
		// even if it WAS called — but more importantly, our test asserts the
		// caller of checkpoint() (fire) is gated by the interval.
		$cp_seg = $ref->getProperty( 'checkpoint_seg' );
		$cp_seg->setAccessible( true );
		$cp_off = $ref->getProperty( 'checkpoint_off' );
		$cp_off->setAccessible( true );
		// Force divergent values so if checkpoint() runs, it WOULD write.
		$cp_seg->setValue( $c, -999 );
		$cp_off->setValue( $c, -999 );

		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertFileDoesNotExist(
			"{$this->tmp}/offsets/r/p0/0.log",
			'within CHECKPOINT_INTERVAL_S, fire must not invoke checkpoint'
		);
	}

	public function test_fire_does_not_invoke_checkpoint_when_offsetlog_disabled(): void {
		// Consumer constructed with empty offsetlog_base_dir → no offsetlog
		// directory ever created, even after fire().
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$c->sink( new Capture_Sink_Node() );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertFalse(
			is_dir( "{$this->tmp}/offsets" ),
			'offsetlog disabled → no directory must appear under offsets/'
		);
	}

	public function test_fire_rearms_timer_with_eof_interval_when_caught_up(): void {
		// After draining all available data, fire() must re-arm with
		// POLL_INTERVAL_EOF_MS (=100) so we back off to 100ms idle ticks.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		// Drain-then-read: the first fire reads 'a' into the buffer (work still
		// pending → busy), the second drains it and reaches the true idle EOF.
		$fire->invoke( $c );
		$fire->invoke( $c );

		// After fire(), poll() reached EOF (all data consumed, no more bytes).
		// EventFramework should have a timer entry for this Consumer with
		// interval_ms = POLL_INTERVAL_EOF_MS.
		$ef         = Event_Framework::instance();
		$ef_ref     = new \ReflectionClass( $ef );
		$timers_p   = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers     = $timers_p->getValue( $ef );
		$id         = \spl_object_id( $c );
		$this->assertArrayHasKey( $id, $timers, 'fire() must register a timer with EventFramework' );
		$this->assertSame(
			Consumer_Node::POLL_INTERVAL_EOF_MS,
			$timers[ $id ]->interval_ms,
			'caught-up fire must re-arm with EOF interval'
		);
		$this->assertTrue( $timers[ $id ]->oneshot, 'fire re-arm must be one-shot' );
	}

	public function test_fire_rearms_timer_with_busy_interval_when_more_data_pending(): void {
		// fire() consults $this->at_eof after poll() to decide BUSY vs EOF rearm.
		// To deterministically exercise the busy branch we use a subclass whose
		// poll() flips at_eof back to false after the parent drain — simulating
		// a producer that's still ahead of us.
		$busy_consumer = new class() extends Consumer_Node {
			public function poll(): void {
				parent::poll();
				// Pretend the writer is still ahead; force the busy branch.
				$ref = new \ReflectionClass( Consumer_Node::class );
				$p   = $ref->getProperty( 'at_eof' );
				$p->setAccessible( true );
				$p->setValue( $this, false );
			}
		};
		$busy_consumer->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $busy_consumer );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $busy_consumer );

		// Inspect the EventFramework's timers map — fire() should have re-armed
		// with POLL_INTERVAL_BUSY_MS (=0) so the next tick drains immediately.
		$ef       = Event_Framework::instance();
		$ef_ref   = new \ReflectionClass( $ef );
		$timers_p = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers   = $timers_p->getValue( $ef );
		$id       = \spl_object_id( $busy_consumer );

		$this->assertArrayHasKey( $id, $timers, 'fire() must register a timer' );
		$this->assertSame(
			Consumer_Node::POLL_INTERVAL_BUSY_MS,
			$timers[ $id ]->interval_ms,
			'busy fire must re-arm with BUSY interval (drain ASAP next tick)'
		);
	}

	// ============================================================================
	// fill() / handle_request() — TM_REQUEST introspection verbs.
	// ============================================================================

	public function test_fill_routes_TM_REQUEST_to_handle_request(): void {
		// fill() must detect TM_REQUEST (without TM_RESPONSE) and dispatch to
		// handle_request() — NOT forward to sink. This is the introspection
		// path that powers GET_LAG / GET_OFFSET verbs.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'one' );
		$this->produce_line( $source, 'two' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'my-consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                       = Message::new_message();
		$req[ Message::TYPE ]      = Message::TM_REQUEST;
		$req[ Message::FROM ]      = 'asker';
		$req[ Message::ID ]        = 'req-1';
		$req[ Message::KEY ]       = 'k';
		$req[ Message::VALUE ]     = 'GET_OFFSET';
		$c->fill( $req );

		$this->assertCount( 1, $cap->captured, 'request must produce exactly one reply' );
		$reply = $cap->captured[0];
		$this->assertSame(
			Message::TM_STRUCT | Message::TM_RESPONSE,
			$reply[ Message::TYPE ],
			'reply must carry TM_STRUCT|TM_RESPONSE'
		);
		$this->assertSame( 'my-consumer', $reply[ Message::FROM ], 'reply FROM = Consumer name' );
		$this->assertSame( 'asker', $reply[ Message::TO ], 'reply TO walks breadcrumb back via FROM' );
		$this->assertSame( 'req-1', $reply[ Message::ID ], 'reply ID echoes request ID' );
		$this->assertSame( 'k', $reply[ Message::KEY ], 'reply KEY echoes request KEY' );
		$this->assertIsArray( $reply[ Message::VALUE ] );
		$this->assertSame( 'GET_OFFSET', $reply[ Message::VALUE ]['verb'] );
		$this->assertIsArray( $reply[ Message::VALUE ]['data'] );
	}

	public function test_handle_request_GET_OFFSET_returns_cursor_and_checkpoint(): void {
		// Spec: GET_OFFSET reply payload is
		// { cursor_seg, cursor_off, checkpoint_seg, checkpoint_off, last_checkpoint_ts }.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );
		$c->checkpoint();
		// poll() forwarded the produced bytestream line to the sink; clear so
		// captured[0] below is the TM_REQUEST reply we're asserting on.
		$cap->captured = [];

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_OFFSET';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertArrayHasKey( 'cursor_seg', $data );
		$this->assertArrayHasKey( 'cursor_off', $data );
		$this->assertArrayHasKey( 'checkpoint_seg', $data );
		$this->assertArrayHasKey( 'checkpoint_off', $data );
		$this->assertArrayHasKey( 'last_checkpoint_ts', $data );
		$this->assertSame( 0, $data['cursor_seg'] );
		$this->assertGreaterThan( 0, $data['cursor_off'] );
		// checkpoint_seg/off match cursor after checkpoint() committed.
		$this->assertSame( $data['cursor_seg'], $data['checkpoint_seg'] );
		$this->assertSame( $data['cursor_off'], $data['checkpoint_off'] );
	}

	public function test_handle_request_GET_LAG_returns_caught_up_when_empty(): void {
		// Spec: GET_LAG reply payload for an empty source partition has
		// bytes_behind=0, segments_behind=0, caught_up=true.
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertSame( 0, $data['bytes_behind'] );
		$this->assertSame( 0, $data['segments_behind'] );
		$this->assertTrue( $data['caught_up'] );
	}

	public function test_handle_request_GET_LAG_returns_bytes_behind_when_unread(): void {
		// With pending bytes on the source partition, GET_LAG must report
		// bytes_behind > 0 and caught_up=false. line_remainder bytes don't
		// inflate the count (they're already "fetched", just not emitted yet).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'pending' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		// Don't poll — leave the bytes behind so the lag computation has work.

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertGreaterThan( 0, $data['bytes_behind'], 'unread bytes must surface in bytes_behind' );
		$this->assertSame( 0, $data['segments_behind'], 'single-segment lag has 0 segments_behind' );
		$this->assertFalse( $data['caught_up'] );
	}

	public function test_handle_request_GET_LAG_counts_segments_behind(): void {
		// Multi-segment: a consumer parked on segment 0 with newer segments
		// available must report segments_behind > 0.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 32 4 86400" );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ), 'need multi-segment for this test' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Park cursor at oldest segment, offset 0 — every newer segment is
		// behind.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$seg->setValue( $c, (int) $segments[0]['id'] );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$off->setValue( $c, 0 );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertGreaterThan( 0, $data['segments_behind'], 'segments_behind must count newer segments' );
		$this->assertGreaterThan( 0, $data['bytes_behind'] );
	}

	public function test_handle_request_GET_LAG_subtracts_buffer_from_bytes_behind(): void {
		// Buffered bytes have been READ but not yet emitted — they must subtract
		// from bytes_behind so the report reflects bytes-still-to-fetch, not
		// bytes-still-to-emit. (Without the subtraction, the read-ahead buffer
		// would double-count.)
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );

		// Pretend we already have 3 bytes buffered (already read).
		$ref = new \ReflectionClass( $c );
		$rem = $ref->getProperty( 'buffer' );
		$rem->setAccessible( true );
		$rem->setValue( $c, 'xyz' ); // 3 bytes

		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data           = $cap->captured[0][ Message::VALUE ]['data'];
		$segments       = $source->get_segments( true );
		$total_bytes    = (int) $segments[0]['size'];
		// line_remainder len = 3, so bytes_behind = total - 3.
		$this->assertSame( $total_bytes - 3, $data['bytes_behind'] );
	}

	public function test_handle_request_unknown_verb_returns_error_payload(): void {
		// Spec: unknown verbs reply with `[ 'error' => "unknown request verb: $VERB" ]`.
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'WHO_KNOWS';
		$c->fill( $req );

		$this->assertCount( 1, $cap->captured );
		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertArrayHasKey( 'error', $data );
		$this->assertStringContainsString( 'WHO_KNOWS', $data['error'] );
		$this->assertSame( 'WHO_KNOWS', $cap->captured[0][ Message::VALUE ]['verb'] );
	}

	public function test_handle_request_verb_is_case_insensitive_and_strips_args(): void {
		// Spec: verb extraction is strtoupper(explode(' ', trim($value), 2)[0]).
		// "get_offset extra args" → GET_OFFSET.
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = '  get_offset trailing args ignored  ';
		$c->fill( $req );

		$reply = $cap->captured[0];
		$this->assertSame( 'GET_OFFSET', $reply[ Message::VALUE ]['verb'] );
		$data = $reply[ Message::VALUE ]['data'];
		// GET_OFFSET shape (not the error shape) — verifies the verb was
		// recognized after trim+upper+arg-strip.
		$this->assertArrayHasKey( 'cursor_seg', $data );
	}

	public function test_handle_request_reply_uses_stamp_override_in_FROM(): void {
		// IPC input Consumer (cli/scaffolding case): set_stamp_as('_repl') —
		// the request reply's FROM must use the override, NOT the underlying
		// name. Otherwise replies wouldn't route through the worker's _repl
		// Partition.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'real-name' );
		$c->set_stamp_as( '_repl' );

		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'cli';
		$req[ Message::VALUE ] = 'GET_OFFSET';
		$c->fill( $req );

		$this->assertSame( '_repl', $cap->captured[0][ Message::FROM ], 'reply FROM uses stamp_override' );
	}

	// ============================================================================
	// resolve_downstream_targets() — Tee target expansion in checkpoint metadata.
	// ============================================================================

	public function test_resolve_downstream_targets_expands_Tee_to_its_targets(): void {
		// When the Consumer's target is a Tee, resolve_downstream_targets
		// expands the Tee's targets so the dashboard sees the actual
		// downstream processors (RequestBuilder, JobRouter, ...), not the
		// plumbing Tee in between.
		$processor_a = new Capture_Sink_Node();
		$processor_a->name( 'processor-a' );
		$processor_b = new Capture_Sink_Node();
		$processor_b->name( 'processor-b' );

		$tee = new \Newspack_Nodes\Tee_Node();
		$tee->name( 'firehose:tee' );
		$tee->connect_node( 'processor-a' );
		$tee->connect_node( 'processor-b' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$message            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $message[ Message::VALUE ];

		$this->assertCount( 2, $entry['targets'], 'Tee must expand to N targets' );
		$names = \array_column( $entry['targets'], 'name' );
		$this->assertContains( 'processor-a', $names );
		$this->assertContains( 'processor-b', $names );
		// Class column is the shell-name of the node (Capture_Sink here).
		foreach ( $entry['targets'] as $t ) {
			$this->assertSame( 'Capture_Sink', $t['class'] );
		}
	}

	public function test_resolve_downstream_targets_handles_Tee_with_missing_inner_node(): void {
		// Tee fans to a name with no registered node — surface the name with
		// an empty class column rather than throwing or dropping the row.
		$tee = new \Newspack_Nodes\Tee_Node();
		$tee->name( 'firehose:tee' );
		$tee->connect_node( 'ghost' ); // no Core::node('ghost') registered.

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$message            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $message[ Message::VALUE ];

		$this->assertCount( 1, $entry['targets'] );
		$this->assertSame( 'ghost', $entry['targets'][0]['name'] );
		$this->assertSame( '', $entry['targets'][0]['class'], 'missing target surfaces empty class' );
	}

	public function test_resolve_downstream_targets_skips_empty_string_in_Tee_targets(): void {
		// Tee's target array shouldn't contain '' in production, but if it
		// does (defensive), resolve_downstream_targets must skip it rather
		// than emit `{name:'', class:''}` rows.
		$tee = new \Newspack_Nodes\Tee_Node();
		$tee->name( 'firehose:tee' );
		// Set target directly to an array with an empty string and a real one.
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, [ '', 'real' ] );

		$real = new Capture_Sink_Node();
		$real->name( 'real' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$message            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $message[ Message::VALUE ];

		$this->assertCount( 1, $entry['targets'], 'empty-string target must be skipped' );
		$this->assertSame( 'real', $entry['targets'][0]['name'] );
	}

	public function test_resolve_downstream_targets_handles_Tee_with_non_array_target(): void {
		// Defensive branch: Tee object whose target is somehow a string
		// (corrupted state, mid-construction) collapses into a single-row
		// `{name:<consumer-target>, class:'Tee'}` entry.
		$tee = new \Newspack_Nodes\Tee_Node();
		$tee->name( 'firehose:tee' );
		// Force target to a string — bypasses Tee's normal array form.
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, 'unexpected-string' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		// Call resolve_downstream_targets directly via reflection so we test
		// just this branch in isolation.
		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
		$rdt->setAccessible( true );
		$out = $rdt->invoke( $c );

		$this->assertCount( 1, $out );
		$this->assertSame( 'firehose:tee', $out[0]['name'] );
		$this->assertSame( 'Tee', $out[0]['class'] );
	}

	public function test_resolve_downstream_targets_expands_Tee_subclass_Tap_to_its_targets(): void {
		// Tap_Node is a Tee subclass — its instanceof Tee_Node, so a Consumer
		// targeting a Tap must expand to the Tap's targets the same way a Tee does.
		$processor_a = new Capture_Sink_Node();
		$processor_a->name( 'processor-a' );
		$processor_b = new Capture_Sink_Node();
		$processor_b->name( 'processor-b' );

		$tap = new \Newspack_Nodes\Tap_Node();
		$tap->name( 'firehose:tap' );
		$tap->connect_node( 'processor-a' );
		$tap->connect_node( 'processor-b' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tap' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$message        = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $message[ Message::VALUE ];

		$this->assertCount( 2, $entry['targets'], 'Tap must expand to N targets' );
		$names = \array_column( $entry['targets'], 'name' );
		$this->assertContains( 'processor-a', $names );
		$this->assertContains( 'processor-b', $names );
	}

	public function test_resolve_downstream_targets_uses_actual_class_for_non_array_Tap_target(): void {
		// Tee-family node whose target is somehow a non-array (corrupted /
		// mid-construction) collapses into a single-row entry whose class is the
		// node's ACTUAL shell-name (Tap), not a hardcoded 'Tee'.
		$tap = new \Newspack_Nodes\Tap_Node();
		$tap->name( 'firehose:tap' );
		$ref = new \ReflectionProperty( $tap, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tap, 'unexpected-string' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tap' );
		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
		$rdt->setAccessible( true );
		$out = $rdt->invoke( $c );

		$this->assertCount( 1, $out );
		$this->assertSame( 'firehose:tap', $out[0]['name'] );
		$this->assertSame( 'Tap', $out[0]['class'] );
	}

	public function test_resolve_downstream_targets_returns_empty_when_no_target(): void {
		// Consumer with no target → returns []. Verified via the direct call
		// since the checkpoint() path always sets `targets` to whatever it
		// returns.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );

		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
		$rdt->setAccessible( true );

		$this->assertSame( [], $rdt->invoke( $c ), 'no target → empty list' );
	}

	public function test_resolve_downstream_targets_handles_non_Tee_target_class(): void {
		// Target resolves to a non-Tee node — single-row `{name, class}` with
		// the actual node's ShortName.
		$processor = new Capture_Sink_Node();
		$processor->name( 'just-a-processor' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'just-a-processor' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$message            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $message[ Message::VALUE ];

		$this->assertCount( 1, $entry['targets'] );
		$this->assertSame( 'just-a-processor', $entry['targets'][0]['name'] );
		$this->assertSame( 'Capture_Sink', $entry['targets'][0]['class'] );
	}

	// ============================================================================
	// set_stamp_as — coverage of the standalone setter.
	// ============================================================================

	public function test_set_stamp_as_changes_FROM_stamp_on_emit(): void {
		// Standalone coverage of set_stamp_as(): empty default falls back to
		// $this->name, but once set it replaces it on every poll-emitted msg.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'one' );
		$this->produce_line( $source, 'two' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'real' );
		$c->set_stamp_as( 'override-stamp' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 2, $cap->captured );
		$this->assertSame( 'override-stamp', $cap->captured[0][ Message::FROM ] );
		$this->assertSame( 'override-stamp', $cap->captured[1][ Message::FROM ] );

		// Re-set to '' — must fall back to name on the next emit.
		$c->set_stamp_as( '' );
		$this->produce_line( $source, 'three' );
		$this->pump_consumer( $c );
		$this->assertSame( 'real', $cap->captured[2][ Message::FROM ] );
	}

	// ============================================================================
	// Constructor: arguments() round-trip + ephemeral mode.
	// ============================================================================

	public function test_constructor_sets_arguments_for_dump_config_roundtrip(): void {
		// Constructor stores ctor args in $this->arguments so dump_config can
		// emit a `make_node Consumer NAME <source_dir> <offsetlog>` line that
		// re-creates this instance.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p2 {$this->tmp}/offsets/r/p2" );
		$this->assertSame(
			"{$this->tmp}/data/p2 {$this->tmp}/offsets/r/p2",
			$c->arguments()
		);
	}

	public function test_constructor_ephemeral_mode_records_empty_offsetlog_in_arguments(): void {
		// Ephemeral consumer (no offsetlog) — arguments still reflect the
		// trailing empty string so the make_node round-trip is unambiguous.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$this->assertSame( "{$this->tmp}/data/p0 ", $c->arguments() );
	}

	// ============================================================================
	// node_schema() — palette manifest for the topology console.
	// ============================================================================

	public function test_node_schema_declares_io_category_and_request_verbs(): void {
		// Topology console reads node_schema() to render the palette entry.
		// Consumer is in the I/O category and declares two request verbs
		// (GET_LAG, GET_OFFSET) — both surfaceable in the topology editor
		// as introspection requests an operator can fire from the canvas.
		$schema = Consumer_Node::node_schema();
		$this->assertIsArray( $schema );
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertNotSame( '', $schema['description'] );
		$this->assertIsArray( $schema['arguments'] );
		$this->assertIsArray( $schema['commands'] );
		$this->assertSame(
			[ 'set_snapshot_node', 'set_line_mode', 'SEEK_FRAME', 'PAUSE', 'PLAY', 'STEP' ],
			\array_column( $schema['commands'], 'name' ),
			'Consumer exposes the snapshot-cache + line-mode config verbs plus the time-travel transport (STEP is a mutating command, not a request)'
		);

		// Two ctor params: source_dir (required), offsetlog_base_dir (default '').
		$this->assertCount( 2, $schema['arguments'] );
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame(
			[ 'source_dir', 'offsetlog_base_dir' ],
			$names
		);

		// Request verbs are READ-ONLY: GET_LAG + GET_OFFSET + the time-travel read
		// verbs. STEP is NOT here — it mutates, so it's an auth-gated command.
		$this->assertCount( 4, $schema['requests'] );
		$verbs = \array_column( $schema['requests'], 'name' );
		$this->assertContains( 'GET_LAG', $verbs );
		$this->assertContains( 'GET_OFFSET', $verbs );
		$this->assertContains( 'LIST_FRAMES', $verbs );
		$this->assertContains( 'READ_STATE', $verbs );
		$this->assertNotContains( 'STEP', $verbs, 'STEP mutates — it must not be an un-gated request verb' );
		foreach ( $schema['requests'] as $req ) {
			$this->assertNotSame( '', $req['description'] );
			$this->assertNotSame( '', $req['reply_shape'] );
		}
	}

	// ============================================================================
	// next_offset() — explicit array with default off when not provided.
	// ============================================================================

	public function test_next_offset_array_defaults_offset_to_zero_when_missing(): void {
		// Explicit-array form: seg=5 with no 'off' key. The off lookup uses
		// `? 0` so absent off lands at 0 — matches the spec "explicit position
		// with seg only".
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( [ 'seg' => 7 ] );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		$this->assertSame( 7, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ), 'missing off must default to 0' );
	}

	public function test_next_offset_array_defaults_seg_to_zero_when_missing(): void {
		// Explicit-array form: off=42 with no 'seg' key. Defaults to 0.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( [ 'off' => 42 ] );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 42, $off->getValue( $c ) );
	}

	public function test_next_offset_recent_with_single_segment_picks_that_one(): void {
		// 'recent' fallback: when there's only ONE segment, pick the oldest
		// (which is also the newest in that case). Distinct from the
		// already-tested multi-segment 'recent' path.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'only' );

		$segments = $source->get_segments( true );
		$this->assertCount( 1, $segments, 'precondition: single segment' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'recent' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$this->assertSame( $segments[0]['id'], $seg_prop->getValue( $c ), 'single-segment recent picks that segment' );
		$this->assertSame( 0, $off_prop->getValue( $c ), 'recent always resets off to 0' );
	}

	public function test_next_offset_end_with_no_segments_leaves_cursor_at_default(): void {
		// 'end' on an empty source must NOT crash and must NOT advance the
		// cursor (segments empty → switch case is a no-op).
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'end' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$this->assertSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ) );
	}

	public function test_next_offset_recent_with_no_segments_leaves_cursor_at_default(): void {
		// 'recent' on an empty source must early-exit cleanly.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'recent' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$this->assertSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ) );
	}

	// ============================================================================
	// load_offsetlog() — early-return when offsetlog disabled.
	// ============================================================================

	public function test_load_offsetlog_null_guard_returns_when_offsetlog_unset(): void {
		// Direct exercise of the null guard inside load_offsetlog: a
		// Consumer constructed with offsetlog_base_dir='' leaves
		// $this->offsetlog at null. Calling load_offsetlog() (via reflection)
		// must return immediately without touching the filesystem.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );

		$ref    = new \ReflectionMethod( Consumer_Node::class, 'load_offsetlog' );
		$ref->setAccessible( true );
		$ref->invoke( $c );

		// Cursor stays at default; no offsets directory appears.
		$rc      = new \ReflectionClass( $c );
		$seg     = $rc->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off     = $rc->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
		$this->assertFalse( \is_dir( "{$this->tmp}/offsets" ) );
	}

	// ============================================================================
	// poll() — empty-source early-exit and read-cap branches.
	// ============================================================================

	public function test_poll_empty_source_sets_at_eof_and_returns(): void {
		// poll() on an empty source (no segments) sets at_eof=true and
		// returns without emitting anything. Different from the cursor-
		// segment-deleted recovery branch since `empty($segments)` is the
		// first early-exit.
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Force at_eof to false so we can verify poll() flips it back.
		$ref    = new \ReflectionClass( $c );
		$at_eof = $ref->getProperty( 'at_eof' );
		$at_eof->setAccessible( true );
		$at_eof->setValue( $c, false );

		$c->poll();

		$this->assertCount( 0, $cap->captured );
		$this->assertTrue( $at_eof->getValue( $c ), 'empty source sets at_eof' );
	}

	public function test_poll_skips_segments_older_than_cursor(): void {
		// Cursor parked on a newer segment must skip older segments in the
		// poll loop. The `$s['id'] < $this->cursor_seg → continue` branch.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 32 4 86400" );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ) );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Park cursor at NEWEST segment, off=size so nothing to read.
		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$newest = \end( $segments );
		$seg_prop->setValue( $c, (int) $newest['id'] );
		$off_prop->setValue( $c, (int) $newest['size'] );

		$c->poll();

		$this->assertCount( 0, $cap->captured, 'no new bytes → no emissions' );
		// at_eof should be true after poll.
		$at_eof_prop = $ref->getProperty( 'at_eof' );
		$at_eof_prop->setAccessible( true );
		$this->assertTrue( $at_eof_prop->getValue( $c ) );
	}

	public function test_poll_skips_line_that_fails_unpacked_and_continues(): void {
		// A genuinely corrupt on-disk line (here a too-few-fields array that
		// Message::unpacked() rejects) followed by a valid packed line. The drain
		// loop must skip the bad line and still emit the following valid one, not
		// abort the poll. Written raw because packed() now slices to 7 fields, so
		// it can no longer be coaxed into emitting a malformed line itself.
		$seg_dir = "{$this->tmp}/data/p0";
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		@\mkdir( $seg_dir, 0755, true );

		$good                   = Message::new_message();
		$good[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$good[ Message::VALUE ] = 'keepme';
		\file_put_contents( "{$seg_dir}/0.log", "[1,2,3]\n" . Message::packed( $good ) . "\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );

		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $capture->captured );
		$this->assertSame( [ 'keepme' ], $values );
	}

	public function test_construct_ignores_unparseable_offsetlog_entry(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		// Write a real checkpoint, then corrupt that entry in place at the same
		// byte length (segment size unchanged) so it is a complete-but-
		// unparseable offsetlog line. A fresh Consumer must seed past it without
		// throwing, starting from the default cursor (0/0).
		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c1->sink( new Capture_Sink_Node() );
		$c1->poll();
		$c1->checkpoint();
		unset( $c1 );

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$nl             = \strpos( $content, "\n" );
		\file_put_contents( $offsetlog_path, \str_repeat( 'x', (int) $nl ) . \substr( $content, (int) $nl ) );
		\clearstatcache();

		$c2  = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionObject( $c2 );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 0, $seg->getValue( $c2 ) );
		$this->assertSame( 0, $off->getValue( $c2 ) );
	}

	public function test_named_consumer_registers_source_sibling(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$c->name( 'feed' );
		$this->assertSame( $c, Core::node( 'feed' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:source' ) );
	}

	public function test_named_consumer_registers_offsetlog_sibling_when_offsetlog_set(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:source' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:offsetlog' ) );
	}

	public function test_consumer_without_offsetlog_does_not_register_offsetlog_sibling(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$c->name( 'feed' );
		$this->assertNull( Core::node( 'feed:offsetlog' ) );
	}

	public function test_renaming_consumer_renames_children_and_unregisters_old_names(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'old' );
		// PHPUnit promotes E_WARNING to a failure, so a $node-typo undefined-
		// variable in the parent:: call surfaces here without an extra guard.
		$c->name( 'new' );
		$this->assertNull( Core::node( 'old' ) );
		$this->assertNull( Core::node( 'old:source' ) );
		$this->assertNull( Core::node( 'old:offsetlog' ) );
		$this->assertSame( $c, Core::node( 'new' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'new:source' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'new:offsetlog' ) );
	}

	public function test_naming_consumer_null_throws(): void {
		// A named Consumer is committed until remove_node(); name(null) throws.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$this->expectException( \RuntimeException::class );
		$c->name( null );
	}

	public function test_naming_consumer_empty_string_throws(): void {
		// '' is the other "no value" input — name('') throws too.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$this->expectException( \RuntimeException::class );
		$c->name( '' );
	}

	public function test_remove_node_unregisters_self_and_children(): void {
		// remove_node() (not name(null)) is the teardown path; it cascades to
		// both Partition children.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:source' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:offsetlog' ) );

		$c->remove_node();
		$this->assertNull( Core::node( 'feed' ) );
		$this->assertNull( Core::node( 'feed:source' ) );
		$this->assertNull( Core::node( 'feed:offsetlog' ) );
	}

	public function test_child_name_collision_throws_via_check_name_availability(): void {
		$squatter = new Partition_Node();
		$squatter->name( 'feed:source' );
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$this->expectException( \RuntimeException::class );
		$c->name( 'feed' );
	}

	public function test_sink_cascades_to_both_children(): void {
		$downstream = new Capture_Sink_Node();
		$c          = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$c->sink( $downstream );
		$this->assertSame( $downstream, Core::node( 'feed:source' )->sink() );
		$this->assertSame( $downstream, Core::node( 'feed:offsetlog' )->sink() );
		$this->assertSame( $downstream, $c->sink() );
	}

	public function test_remove_node_removes_both_children(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$c->remove_node();
		$this->assertNull( Core::node( 'feed' ) );
		$this->assertNull( Core::node( 'feed:source' ) );
		$this->assertNull( Core::node( 'feed:offsetlog' ) );
	}

	public function test_consumer_named_zero_registers_zero_prefixed_children(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( '0' );
		$this->assertSame( '0', $c->name() );
		$this->assertSame( $c, Core::node( '0' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( '0:source' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( '0:offsetlog' ) );
	}

	// ============================================================================
	// Rule 2 sibling contract: source / offsetlog Partitions are plumbing of the
	// Consumer — named, patron-set to the owning Consumer (so dump_metadata hides
	// them from the canvas), and sunk via the Consumer's own cascaded sink (their
	// specific sink, so they're NOT additionally sunk to _command_interpreter).
	// ============================================================================

	public function test_source_sibling_is_named_and_patron_set_to_consumer(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$c->name( 'feed' );

		$source = Core::node( 'feed:source' );
		$this->assertInstanceOf( Partition_Node::class, $source );
		$this->assertSame( 'feed:source', $source->name() );
		$this->assertSame( $c, $source->patron(), 'source must mark the Consumer as its patron' );
	}

	public function test_offsetlog_sibling_is_named_and_patron_set_to_consumer(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );

		$offsetlog = Core::node( 'feed:offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$this->assertSame( 'feed:offsetlog', $offsetlog->name() );
		$this->assertSame( $c, $offsetlog->patron(), 'offsetlog must mark the Consumer as its patron' );
	}

	public function test_siblings_use_consumer_cascaded_sink_not_interpreter(): void {
		// Rule 2(c): a sibling that already sets a specific sink is NOT additionally
		// sunk to _command_interpreter. The Consumer cascades its OWN sink to both
		// Partition children, so their sink is the downstream node, never the CI.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );

		$downstream = new Capture_Sink_Node();
		$c          = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'feed' );
		$c->sink( $downstream );

		$this->assertSame( $downstream, Core::node( 'feed:source' )->sink() );
		$this->assertSame( $downstream, Core::node( 'feed:offsetlog' )->sink() );
		$this->assertNotSame( $interpreter, Core::node( 'feed:source' )->sink() );
		$this->assertNotSame( $interpreter, Core::node( 'feed:offsetlog' )->sink() );
	}
}

/** A node with the duck-typed save_state/restore_state the Consumer snapshots. */
class Snapshot_Probe extends Node {
	/** @var array<string, mixed> */
	public array $state = [];
	public function save_state(): array {
		return $this->state;
	}
	public function restore_state( array $saved ): void {
		$this->state = $saved;
	}
}

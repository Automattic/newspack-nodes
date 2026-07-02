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
use Newspack_Nodes\Router_Node;
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
	 * the node_schema and assigns source_dir + an offsetlog_dir token.
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p2 {$this->tmp}/offsets.p2" );
		$ref = new \ReflectionClass( $c );
		$this->assertSame( "{$this->tmp}/data.p2",      $ref->getProperty( 'source_dir' )->getValue( $c ) );
		$this->assertSame( "{$this->tmp}/offsets.p2", $ref->getProperty( 'offsetlog_dir' )->getValue( $c ) );
		$this->assertInstanceOf( Partition_Node::class, $ref->getProperty( 'offsetlog' )->getValue( $c ) );
	}

	public function test_arguments_builds_deadletter_sibling_when_dir_given(): void {
		// A third positional arg names the quarantine dir for poison messages
		// (dead-letter [42]); the Consumer auto-builds a `:deadletter` sibling
		// Partition there, the same way it builds `:offsetlog`.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$ref = new \ReflectionClass( $c );
		$this->assertSame( "{$this->tmp}/deadletter.p0", $ref->getProperty( 'deadletter_dir' )->getValue( $c ) );
		$this->assertInstanceOf( Partition_Node::class, $ref->getProperty( 'deadletter' )->getValue( $c ) );
	}

	public function test_empty_deadletter_dir_skips_the_sibling(): void {
		// No deadletter dir → no quarantine sibling; poison is logged and dropped.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$ref = new \ReflectionClass( $c );
		$this->assertNull( $ref->getProperty( 'deadletter' )->getValue( $c ) );
		$this->assertSame( '', $ref->getProperty( 'deadletter_dir' )->getValue( $c ) );
	}

	public function test_sidecar_partitions_have_no_config_interpreter(): void {
		// Roadmap [83]: a patron-managed sidecar (the Consumer's source/offsetlog)
		// shouldn't carry its own `{name}:config` — the patron configures it
		// directly, and dump_config already skips patron-owned nodes.
		$c = new Consumer_Node();
		$c->name( 'reader' );
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );

		$this->assertNotNull( Core::node( 'reader:source' ) );
		$this->assertNull( Core::node( 'reader:source:config' ) );
		$this->assertNull( Core::node( 'reader:offsetlog:config' ) );

		// Control: a standalone Partition (no patron) keeps its :config.
		$p = new Partition_Node();
		$p->name( 'standalone' );
		$p->arguments( "{$this->tmp}/data/s0" );
		$this->assertNotNull( Core::node( 'standalone:config' ) );
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
	 * Empty `offsetlog_dir` token leaves the offsetlog Partition null
	 * (ephemeral readers skip durable cursors).
	 */
	public function test_arguments_setter_with_empty_offsetlog_skips_offsetlog_partition(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$ref = new \ReflectionClass( $c );
		$this->assertNull( $ref->getProperty( 'offsetlog' )->getValue( $c ) );
		$this->assertSame( '', $ref->getProperty( 'offsetlog_dir' )->getValue( $c ) );
	}

	/**
	 * Schema default for offsetlog_dir is '' (not '<config:...>') — so
	 * calling arguments() with only the two required tokens leaves the optional
	 * offsetlog at '' rather than a placeholder string.
	 */
	public function test_arguments_setter_applies_empty_default_for_missing_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$message_a  = $this->produce( 'first' );
		$source->fill( $message_a );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$first  = $this->produce( 'first' );
		$second = $this->produce( 'second' );
		$source->fill( $first );
		$source->fill( $second );
		$source->flush();

		$c = new Consumer_Node();
		$c->name( 'firehose' );
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets/firehose.job-router.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$stats = $c->probe_stats();
		$this->assertCount( 10, $stats, 'lean positional record' );
		// READER = offsetlog dir basename; SOURCE = partition tailed (its basename).
		$this->assertSame( 'firehose.job-router.p0', $stats[ Probe_Record::READER ] );
		$this->assertSame( 'data.p0', $stats[ Probe_Record::SOURCE ] );
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

	public function test_probe_stats_reports_offsetlog_cache_size_after_checkpoint(): void {
		// CACHE_SIZE = byte size of the newest offsetlog segment. After a checkpoint
		// the offsetlog is non-empty, so the probe reports its real on-disk size.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$msg = $this->produce( 'first' );
		$source->fill( $msg );
		$source->flush();

		$c = new Consumer_Node();
		$c->name( 'firehose' );
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets/firehose.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint();

		$this->assertGreaterThan(
			0,
			$c->probe_stats()[ Probe_Record::CACHE_SIZE ]
		);
	}

	public function test_probe_stats_cache_size_is_zero_without_an_offsetlog(): void {
		// An ephemeral reader (empty offsetlog token) keeps no durable cursor, so
		// there is no offsetlog segment to size → CACHE_SIZE is 0.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$msg = $this->produce( 'first' );
		$source->fill( $msg );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$this->assertSame( 0, $c->probe_stats()[ Probe_Record::CACHE_SIZE ] );
	}

	public function test_probe_stats_round_trips_through_cli_consumer_rows(): void {
		// Pin the writer→reader contract by index: the exact positions probe_stats()
		// WRITES are the positions CLI::consumer_rows() READS back off the log.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$first = $this->produce( 'first' );
		$source->fill( $first );
		$source->flush();

		$c = new Consumer_Node();
		$c->name( 'firehose' );
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets/firehose.job-router.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $value;
		$partition->fill( $message );
		// Partition::fill batches in memory now — force on-disk visibility
		// so the Consumer's poll() picks up the bytes synchronously.
		$partition->flush();
	}

	public function test_drain_emits_every_record_then_a_terminal_tm_eof(): void {
		// Synchronous Tachikoma-v2.0 drain(): read the source to EOF, fill() each
		// unpacked Message into the sink, then a single terminal TM_EOF — the whole
		// messaging interface reqgrep consumes instead of hand-rolling read_at + decode.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$c->drain();

		$this->assertCount( 3, $capture->captured, 'two records + one terminal EOF' );
		$this->assertSame( 'first',  $capture->captured[0][ Message::VALUE ] );
		$this->assertSame( 'second', $capture->captured[1][ Message::VALUE ] );
		$this->assertNotSame(
			0,
			$capture->captured[2][ Message::TYPE ] & Message::TM_EOF,
			'drain() closes with a TM_EOF'
		);
	}

	public function test_poll_does_not_re_emit_old_lines_on_second_call(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );
		$this->produce_line( $source, 'c' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->set_line_mode( true );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );

		$values = \array_map( static fn ( array $m ): mixed => $m[ Message::VALUE ], $capture->captured );
		$this->assertSame( [ 'a', 'b', 'c' ], $values );
	}

	public function test_line_mode_emits_at_most_one_entry_per_poll(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 32 4 86400" );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );
		$this->assertGreaterThanOrEqual( 2, \count( $source->get_segments( true ) ), 'need multiple segments' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$_SERVER['NEWSPACK_NODES_WORKER_TYPE'] = 'firehose-workers';

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint();

		// Offsetlog stores packed Tachikoma messages whose VALUE is the
		// {seg, off, ts} struct. The packed line should mention "seg" and "off".
		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
		$this->assertTrue( file_exists( $offsetlog_path ), 'Offsetlog must exist after checkpoint' );
		$content = (string) file_get_contents( $offsetlog_path );
		$message     = Message::unpacked( rtrim( $content, "\n" ) );
		$entry   = $message[ Message::VALUE ];
		$this->assertSame( 0, $entry['seg'] );
		$this->assertGreaterThan( 0, $entry['off'] );
	}

	public function test_checkpoint_records_attempts_at_healthy_baseline(): void {
		// The offsetlog frame carries an `attempts` counter so a respawn can tell a
		// stuck/poison cursor (climbing attempts) from healthy progress. A normal
		// running checkpoint writes the healthy baseline of 1 (0 is reserved for a
		// graceful-shutdown handoff at a genuinely un-attempted cursor).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint();

		$content = (string) file_get_contents( "{$this->tmp}/offsets.p0/0.log" );
		$entry   = Message::unpacked( rtrim( $content, "\n" ) )[ Message::VALUE ];
		$this->assertSame( 1, $entry['attempts'] );
	}

	public function test_graceful_checkpoint_records_attempts_zero(): void {
		// A graceful shutdown checkpoints at a cursor whose next message has NOT yet
		// been attempted — a clean handoff, not a strike — so it stamps attempts=0.
		// The respawn then resumes at attempts+1 = 1 (a virgin first attempt), so a
		// clean recycle costs nothing, while a crashed in-flight interval costs one.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint( graceful: true );

		$content = (string) file_get_contents( "{$this->tmp}/offsets.p0/0.log" );
		$entry   = Message::unpacked( rtrim( $content, "\n" ) )[ Message::VALUE ];
		$this->assertSame( 0, $entry['attempts'] );
	}

	public function test_boot_resumes_at_prior_attempts_plus_one(): void {
		// A respawned worker re-reads the durable cursor. It resumes at attempts+1 so
		// a stuck/poison cursor that never advances climbs toward the dead-letter
		// threshold each respawn. Here consumer A checkpoints at the healthy baseline
		// (1); a fresh consumer B on the SAME offsetlog must boot and record 2.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $a );
		$a->checkpoint();
		$this->assertSame( 1, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'] );

		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $b ); // first poll → poll_init → load_offsetlog boot-bump.

		$this->assertSame( 2, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'] );
	}

	/**
	 * Read the newest offsetlog keyframe's VALUE. segment_size=1 makes each
	 * checkpoint its own segment ({id}.log), so the newest frame is the last line
	 * of the highest-numbered segment file.
	 *
	 * @return array<array-key, mixed>
	 */
	private function newest_offsetlog_entry( string $dir ): array {
		$paths = \glob( "{$dir}/*.log" );
		\usort( $paths, static fn ( $x, $y ): int => (int) \basename( $x, '.log' ) <=> (int) \basename( $y, '.log' ) );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( (string) \end( $paths ) ) ) ) );
		return Message::unpacked( (string) \end( $lines ) )[ Message::VALUE ];
	}

	/**
	 * Write a single offsetlog keyframe with a chosen cursor + attempt state, to
	 * simulate the durable frame a respawning worker boots on (crash-simulation).
	 */
	private function seed_offsetlog_frame( string $dir, int $seg, int $off, int $attempts, string $reason = '' ): void {
		\mkdir( $dir, 0755, true );
		$m                       = Message::new_message();
		$m[ Message::TYPE ]      = Message::TM_STRUCT;
		$m[ Message::FROM ]      = 'seed';
		$m[ Message::VALUE ]     = [ 'seg' => $seg, 'off' => $off, 'attempts' => $attempts, 'reason' => $reason, 'first_crash_ts' => null ];
		\file_put_contents( "{$dir}/0.log", Message::packed( $m ) . "\n" );
	}

	public function test_checkpoint_resets_attempts_to_baseline_on_forward_progress(): void {
		// Once a recovering worker advances PAST the cursor it booted on, the poison
		// region is behind it — its next interval checkpoint resets to the healthy
		// baseline (1), so a later unrelated crash doesn't inherit a stale strike count.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $a );
		$a->checkpoint();

		// B respawns onto A's cursor → boots at attempts=2 and stays there while stuck.
		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $b );
		$this->assertSame( 2, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'] );

		// New data arrives; B advances past its boot cursor → forward progress.
		$this->produce_line( $source, 'world' );
		$this->pump_consumer( $b );
		$b->checkpoint();

		$this->assertSame( 1, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'] );
	}

	public function test_checkpoint_frame_carries_reason_and_first_crash_ts(): void {
		// The frame carries the dead-letter metadata a respawn classifies on: `reason`
		// (why the prior process stopped — '' = none/hard-crash) and `first_crash_ts`
		// (when the strike streak began, for the 900s state-wipe escalation). A healthy
		// running checkpoint has neither: reason='' and first_crash_ts=null.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint();

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertArrayHasKey( 'reason', $entry );
		$this->assertSame( '', $entry['reason'] );
		$this->assertArrayHasKey( 'first_crash_ts', $entry );
		$this->assertNull( $entry['first_crash_ts'] );
	}

	public function test_boot_stamps_first_crash_ts_on_recovery_and_carries_it(): void {
		// The first respawn onto a still-stuck cursor (attempts climbs past 1) marks
		// WHEN the crash streak began so the 900s state-wipe can time it; later
		// respawns carry that original timestamp forward rather than resetting it.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $a );
		$a->checkpoint(); // healthy frame: attempts=1, first_crash_ts=null.

		Core::$now = 5000.0;
		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $b ); // recovery boot → streak begins now.
		// Numeric compare: a whole-number float round-trips through the frame's JSON as int.
		$this->assertEquals( 5000.0, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['first_crash_ts'] );

		Core::$now = 6000.0; // a later respawn must NOT re-stamp.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$this->assertEquals( 5000.0, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['first_crash_ts'] );
	}

	public function test_graceful_checkpoint_forces_write_past_advance_guard(): void {
		// A clean shutdown must record attempts=0 even when the cursor hasn't moved
		// since the last commit (an idle consumer sitting on its checkpoint). The
		// advance-guard suppresses a normal no-op checkpoint there, but the graceful
		// handoff MUST still write — else the next boot mistakes a clean recycle for a
		// crash and climbs attempts.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );
		$c->checkpoint(); // commits at the current cursor.

		$count = fn (): int => $this->count_offsetlog_records( "{$this->tmp}/offsets.p0" );
		$before = $count();
		$c->checkpoint();           // cursor unchanged → advance-guard no-op.
		$this->assertSame( $before, $count(), 'a non-graceful checkpoint at an unchanged cursor is a no-op' );

		$c->checkpoint( graceful: true ); // must force a write despite the unchanged cursor.
		$this->assertSame( $before + 1, $count() );
		$this->assertSame( 0, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'] );
	}

	public function test_forward_progress_clears_first_crash_ts(): void {
		// Forward progress ends the crash streak: the reset must clear first_crash_ts,
		// not just attempts. Otherwise a stale timestamp rides into healthy frames and
		// a later UNRELATED single crash >900s on the clock trips the state-wipe at once.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $a );
		$a->checkpoint();

		Core::$now = 5000.0;
		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $b ); // recovery boot → first_crash_ts=5000.
		$this->assertEquals( 5000.0, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['first_crash_ts'] );

		$this->produce_line( $source, 'world' );
		$this->pump_consumer( $b ); // advances past the boot cursor.
		$b->checkpoint();

		$this->assertNull( $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['first_crash_ts'], 'forward progress must clear the crash-streak timestamp' );
	}

	public function test_downstream_throw_quarantines_message_and_advances(): void {
		// A downstream node throwing on a message is poison: the Consumer catches it,
		// writes the (replayable) original message to its :deadletter sibling, and
		// advances past it — so one bad message can't wedge the partition, and it's
		// recoverable via `wp nodes ingest` rather than silently dropped.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'poison' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new class() extends Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'handler boom' );
			}
		} );
		$this->pump_consumer( $c );

		// Exactly one quarantined entry proves BOTH the catch AND the advance: had the
		// cursor not moved, drain would re-forward the poison every poll and pile up.
		$this->assertSame( 1, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ) );
	}

	public function test_downstream_worker_should_stop_propagates_not_quarantined(): void {
		// A cooperative stop raised downstream (pump() inside a long handler) is control
		// flow, not poison: it must escape forward_line so the worker shuts down, and the
		// in-flight message must NOT be quarantined.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'msg' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new class() extends Node {
			public function fill( array &$message ): void {
				throw new \Newspack_Nodes\Worker_Should_Stop();
			}
		} );

		try {
			$this->pump_consumer( $c );
			$this->fail( 'expected Worker_Should_Stop to propagate out of forward_line' );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$this->assertSame( 0, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ), 'a cooperative stop must not be quarantined' );
	}

	public function test_quarantined_entry_is_the_replayable_original_message(): void {
		// `wp nodes ingest` replays each DLQ line via Message::unpacked → fill(), so the
		// quarantined entry must be the original message recoverable verbatim — not a
		// metadata wrapper. The diagnostic why rides the rate-limited alert instead.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'poison-payload' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new class() extends Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'boom' );
			}
		} );
		$this->pump_consumer( $c );

		$paths = \glob( "{$this->tmp}/deadletter.p0/*.log" );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( (string) \end( $paths ) ) ) ) );
		$replayed = Message::unpacked( (string) \end( $lines ) );
		$this->assertSame( 'poison-payload', $replayed[ Message::VALUE ] );
		$this->assertSame( Message::TM_BYTESTREAM, (int) $replayed[ Message::TYPE ] );
	}

	public function test_throw_propagates_through_interpreter_and_router_to_deadletter(): void {
		// The real worker sink chain is Consumer → _command_interpreter → _router →
		// processor. A processor throw must traverse that chain UN-swallowed back to
		// forward_line so the message is quarantined: the data path has no catch (only
		// the interpreter's COMMAND path does), which is what lets job-handler throws
		// reach the cursor owner.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$interpreter->sink( $router );

		$boom = new class() extends Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'downstream boom' );
			}
		};
		$boom->name( 'processor' );

		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'poison' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$c->sink( $interpreter );
		$c->target( 'processor' );
		$this->pump_consumer( $c );

		$this->assertSame( 1, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ) );
	}

	public function test_deadletter_write_failure_does_not_wedge_the_partition(): void {
		// If quarantine itself fails (disk full / I/O), the poison must still be
		// dropped and the cursor advanced — a failed DLQ write must NOT re-wedge the
		// partition, which would loop forever: re-read poison → sink throws →
		// dead_letter's write throws → escapes forward_line uncaught → never advances.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'poison' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new class() extends Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'handler boom' );
			}
		} );

		// Swap the DLQ sibling for one whose write itself fails.
		$ref  = new \ReflectionProperty( Consumer_Node::class, 'deadletter' );
		$ref->setValue( $c, new class() extends Partition_Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'disk full' );
			}
		} );

		// Must complete without the DLQ-write failure escaping (no infinite wedge).
		$this->pump_consumer( $c );
		$this->addToAssertionCount( 1 );
	}

	public function test_unparseable_source_line_is_quarantined_not_dropped(): void {
		// A line that won't unpack as a Message will NEVER parse — quarantine it
		// immediately (no retry) for inspection, rather than silently dropping it.
		// The raw bytes are preserved in the DLQ entry's VALUE so an operator can see
		// what arrived.
		\mkdir( "{$this->tmp}/data.p0", 0755, true );
		\file_put_contents( "{$this->tmp}/data.p0/0.log", "this is not a packed message\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 0, $cap->captured, 'an unparseable line must not be forwarded downstream' );
		$this->assertSame( 1, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ), 'it must be quarantined, not dropped' );

		$paths = \glob( "{$this->tmp}/deadletter.p0/*.log" );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( (string) \end( $paths ) ) ) ) );
		$entry = Message::unpacked( (string) \end( $lines ) );
		$this->assertSame( 'this is not a packed message', $entry[ Message::VALUE ], 'the raw bytes are preserved for inspection' );
	}

	public function test_hard_crash_crawl_dead_letters_the_head_on_entry(): void {
		// After CRASH_MAX_ATTEMPTS hard-crash respawns at one cursor (attempts climbed
		// with NO reason = an uncatchable death, not a caught throw), the worker enters
		// crawl mode: it sacrifices the head (the in-flight-at-crash suspect) to the
		// DLQ, skips it, and advances — guaranteeing progress past a poison that kills
		// the process before any catch can run. One accepted false-positive.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'head' );
		$this->produce_line( $source, 'next' );

		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertSame( 1, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ), 'the crawl head is dead-lettered' );
		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
		$this->assertNotContains( 'head', $values, 'the sacrificed head is not forwarded' );
		$this->assertContains( 'next', $values, 'the worker advances past the head' );
	}

	public function test_crawl_checkpoints_each_message_to_pin_the_in_flight_offset(): void {
		// In crawl the cursor is checkpointed per message during polling (not batched,
		// not on the 30s interval) so an uncatchable crash pins the EXACT in-flight
		// offset — the next boot dead-letters precisely that message. A batched single
		// checkpoint couldn't isolate which message in the batch killed the process.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		foreach ( [ 'head', 'A', 'B', 'C' ] as $v ) {
			$this->produce_line( $source, $v );
		}

		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
		$this->assertSame( [ 'A', 'B', 'C' ], $values, 'head sacrificed; the rest forwarded one at a time' );
		// Boot frame + one checkpoint per crawled message — far more than the ≤2 a
		// batched/interval checkpoint would leave.
		$this->assertGreaterThanOrEqual( 4, $this->count_offsetlog_records( "{$this->tmp}/offsets.p0" ), 'crawl checkpoints per message' );
		$this->assertSame( Consumer_Node::CRASH_MAX_ATTEMPTS, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'], 'attempts stays pinned at the threshold during crawl' );
	}

	public function test_crawl_exits_to_healthy_after_surviving_an_interval(): void {
		// Surviving a full checkpoint interval in crawl without an uncatchable crash
		// means the poison is behind us: drop back to coarse mode at the healthy
		// baseline (attempts=1), so we don't pay per-message I/O forever.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'head' );
		$this->produce_line( $source, 'A' );

		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c ); // crawls head-skip + A within the interval; still crawling.
		$this->assertSame( Consumer_Node::CRASH_MAX_ATTEMPTS, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'] );

		// A full interval elapses without a crash, then more data arrives.
		Core::$now = 1000.0 + Consumer_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->produce_line( $source, 'B' );
		$this->pump_consumer( $c );

		$this->assertSame( 1, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'], 'crawl exits to the healthy baseline after surviving an interval' );
	}

	public function test_crawl_does_not_exit_while_the_head_is_unsacrificed(): void {
		// If the boot head never completes (a partial line, no terminating newline)
		// within the interval, crawl must NOT exit on the wall clock — exiting would
		// re-arm the loop by leaving the poison head un-sacrificed for the next boot.
		\mkdir( "{$this->tmp}/data.p0", 0755, true );
		\file_put_contents( "{$this->tmp}/data.p0/0.log", 'partial-head-without-newline' ); // no \n → never drains.
		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, Consumer_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c ); // head is partial → not drained → not sacrificed.

		Core::$now = 1000.0 + Consumer_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->pump_consumer( $c ); // interval elapsed, but the head is still pending.

		$this->assertSame( Consumer_Node::CRASH_MAX_ATTEMPTS, $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" )['attempts'], 'crawl must not exit while the head is unsacrificed' );
	}

	/**
	 * Drive a Consumer until its sink throws Worker_Should_Stop, leaving the in-flight
	 * message buffered at the boot cursor (the realistic mid-job cooperative-stop state).
	 */
	private function stop_on_value( Consumer_Node $c, string $value ): void {
		$c->sink( new class( $value ) extends Node {
			public function __construct( private string $stop_at ) {}
			public function fill( array &$message ): void {
				if ( $this->stop_at === $message[ Message::VALUE ] ) {
					throw new \Newspack_Nodes\Worker_Should_Stop();
				}
			}
		} );
	}

	public function test_cooperative_timeout_strikes_when_stopped_on_the_boot_cursor(): void {
		// A timeout at the message the worker BOOTED on (cursor never advanced, message
		// still buffered) got a fair full-lifetime shot — it counts as a strike: the
		// shutdown stamps reason=timeout at the live attempt count (not the attempts=0
		// graceful handoff), so the respawn climbs toward the dead-letter threshold.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'poison' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$this->stop_on_value( $c, 'poison' );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$c->cooperative_stop( 'timeout', false );

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 'timeout', $entry['reason'], 'a boot-cursor timeout stamps reason=timeout' );
		$this->assertSame( 1, $entry['attempts'], 'the first strike records the live attempt count, not a graceful 0' );
		$this->assertSame( 0, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ), 'one strike is below threshold — no dead-letter yet' );
	}

	public function test_cooperative_timeout_does_not_strike_when_the_cursor_advanced(): void {
		// A late "sliver" message (the worker advanced past its boot cursor before the
		// timeout) did NOT get a fair shot — it's a clean handoff (attempts=0), not a
		// strike. The next fresh worker boots ON it and gives it a full lifetime.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'A' );
		$this->produce_line( $source, 'B' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$c->set_line_mode( true ); // one message per drain, so A advances the cursor before B stops.
		$this->stop_on_value( $c, 'B' );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$c->cooperative_stop( 'timeout', false );

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 0, $entry['attempts'], 'an advanced cursor is a clean handoff, not a strike' );
		$this->assertSame( '', $entry['reason'] );
	}

	public function test_cooperative_timeout_does_not_strike_an_idle_worker(): void {
		// A worker that booted, found nothing to do, and timed out has an empty buffer —
		// no message is in flight, so nothing earned a strike. Clean handoff.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c ); // reaches EOF with an empty buffer.

		$c->cooperative_stop( 'timeout', false );

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 0, $entry['attempts'], 'an idle worker carrying no message is not struck' );
	}

	public function test_counter_counts_only_successfully_forwarded_messages(): void {
		// probe MSGS / throughput reflect work actually delivered downstream. A message
		// quarantined on a throw (or re-delivered after a cooperative stop) must NOT inflate
		// the counter — otherwise a respawn double-counts the same re-delivered message.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'boom' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$c->sink( new class() extends Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'handler boom' );
			}
		} );
		$this->pump_consumer( $c );

		$this->assertSame( 0, $c->probe_stats()[ Probe_Record::MSGS ], 'a quarantined message is not counted as forwarded' );
	}

	public function test_counter_not_incremented_when_dispatch_is_cooperatively_stopped(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'x' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$this->stop_on_value( $c, 'x' );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$this->assertSame( 0, $c->probe_stats()[ Probe_Record::MSGS ], 'a message re-delivered after a stop is not counted' );
	}

	public function test_cooperative_timeout_does_not_strike_a_merely_buffered_message(): void {
		// A message read into the buffer but NEVER dispatched (it just arrived, the timeout
		// fired before the next drain) did not get a fair shot — striking it would penalize
		// a healthy message. Only a message the worker was actively forwarding when the stop
		// hit (stopped_in_fill) counts. The buffered head alone is not enough.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'just-arrived' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$c->sink( new Capture_Sink_Node() );
		// One poll: poll_init runs, get_batch reads the line into the buffer, but it is not
		// forwarded yet (drain runs before the read). So the head is buffered, undispatched.
		$c->poll();

		$c->cooperative_stop( 'timeout', false );

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 0, $entry['attempts'], 'a buffered-but-undispatched message is not struck' );
		$this->assertSame( 0, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ) );
	}

	public function test_cooperative_stop_skips_a_consumer_that_never_polled(): void {
		// If the worker stops BEFORE a consumer's first poll (e.g. memory already over the
		// watermark at boot, or a restart requested on the first should_continue), the
		// in-memory cursor is still the 0:0 construction default. The shutdown handoff must
		// NOT write that 0:0 frame — it would clobber the real durable position and the next
		// boot would rewind to the start of the partition and re-deliver everything.
		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 2, 500, 0 );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$c->sink( new Capture_Sink_Node() );
		// No poll(): the consumer never ran poll_init / load_offsetlog.

		$c->cooperative_stop( 'timeout', false );
		$c->checkpoint( true ); // the operational-stop graceful path must also be guarded.

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 2, $entry['seg'], 'an un-polled consumer must not clobber the durable cursor' );
		$this->assertSame( 500, $entry['off'] );
	}

	public function test_boot_cursor_tracks_a_first_spawn_end_seek(): void {
		// boot_cursor must reflect where the worker actually started reading — including a
		// first-spawn next_offset('end') seek — so cursor_advanced_since_boot() is honest.
		// Otherwise an end-seeking consumer's boot_cursor stays at 0:0 and the fair-shot
		// proxy reports "advanced" for its whole first lifetime.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'pre-existing' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( 'end' ); // seek past the backlog before the first poll.
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$this->assertSame( $this->read_private( $c, 'cursor_seg' ), $this->read_private( $c, 'boot_cursor_seg' ), 'boot_cursor seg tracks the seeked start' );
		$this->assertSame( $this->read_private( $c, 'cursor_off' ), $this->read_private( $c, 'boot_cursor_off' ), 'boot_cursor off tracks the seeked start' );
		$this->assertGreaterThan( 0, $this->read_private( $c, 'boot_cursor_off' ), 'the end seek moved boot_cursor off 0:0' );
	}

	public function test_cooperative_timeout_dead_letters_after_the_strike_threshold(): void {
		// The boot-cursor message has now consumed COOP_MAX_ATTEMPTS full lifetimes
		// (a prior frame records the first strike). The second strike exhausts the
		// budget: quarantine the message, advance past it, and hand off at the virgin
		// baseline so the next message gets a fresh first attempt.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'poison' );
		$this->produce_line( $source, 'after' );

		// Seed the first-strike frame so the boot resumes at the second attempt.
		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, Consumer_Node::COOP_MAX_ATTEMPTS - 1, 'timeout' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'jobs:consumer' );
		$this->stop_on_value( $c, 'poison' );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$c->cooperative_stop( 'timeout', false );

		$this->assertSame( 1, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ), 'the message is quarantined after exhausting its fair shots' );
		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 0, $entry['attempts'], 'after the dead-letter the advanced cursor hands off at the virgin baseline' );
		$this->assertGreaterThan( 0, $entry['off'], 'the cursor advanced past the quarantined message' );
	}

	public function test_cooperative_memory_does_not_strike_when_baseline_near_watermark(): void {
		// A memory stop whose FRESH baseline was already near the watermark is a leak or
		// an undersized memory_limit, not a single poison message: alert, do not strike.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'innocent' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$this->stop_on_value( $c, 'innocent' );
		Core::set_stderr_handler( static function () { /* swallow the alert */ } );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$c->cooperative_stop( 'memory', true ); // baseline_near_watermark = true.

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 0, $entry['attempts'], 'a high-baseline memory stop is not the message\'s fault — no strike' );
		$this->assertSame( 0, $this->count_offsetlog_records( "{$this->tmp}/deadletter.p0" ) );
	}

	public function test_cooperative_memory_strikes_when_baseline_is_healthy(): void {
		// A single message that drove a large memory delta from a HEALTHY baseline IS
		// the culprit — it counts as a strike just like a timeout.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hog' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' );
		$this->stop_on_value( $c, 'hog' );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$c->cooperative_stop( 'memory', false ); // healthy baseline.

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 'memory', $entry['reason'] );
		$this->assertSame( 1, $entry['attempts'] );
	}

	public function test_cooperative_stop_advances_past_lines_forwarded_before_a_midbatch_stop(): void {
		// In batch mode a cooperative stop can propagate mid-batch (a pump() inside one
		// fill). Lines already handed to the sink are done — the cursor must advance past
		// them (single chop in a finally), so the fair-shot proxy sees the real in-flight
		// message, not the innocent boot head.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'A' );
		$this->produce_line( $source, 'B' );
		$this->produce_line( $source, 'C' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$this->stop_on_value( $c, 'C' ); // A and B forward; C stops mid-batch.
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		// The cursor advanced past A and B; C is the buffered head.
		$this->assertGreaterThan( 0, $this->read_private( $c, 'cursor_off' ), 'forwarded lines advance the cursor even on a mid-batch stop' );
		$buffer   = (string) $this->read_private( $c, 'buffer' );
		$head_nl  = \strpos( $buffer, "\n" );
		$head     = false === $head_nl ? $buffer : \substr( $buffer, 0, $head_nl );
		$this->assertSame( 'C', Message::unpacked( $head )[ Message::VALUE ], 'the un-forwarded in-flight message stays at the buffer head' );
	}

	public function test_set_line_mode_verb_enables_only_on_an_explicit_truthy_arg(): void {
		// Only 1/true/yes/on enable line mode; a bare/empty verb (or any other value)
		// disables it — so an accidental click is reversible and the default is "off".
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->patron( $c );

		Consumer_Node::cmd_set_line_mode( $interpreter, 'true' );
		$this->assertTrue( $this->read_private( $c, 'line_mode' ), 'an explicit truthy arg enables it' );

		Consumer_Node::cmd_set_line_mode( $interpreter, '' );
		$this->assertFalse( $this->read_private( $c, 'line_mode' ), 'a bare/empty verb disables it' );

		Consumer_Node::cmd_set_line_mode( $interpreter, 'on' );
		$this->assertTrue( $this->read_private( $c, 'line_mode' ) );

		Consumer_Node::cmd_set_line_mode( $interpreter, 'false' );
		$this->assertFalse( $this->read_private( $c, 'line_mode' ), 'an explicit falsey arg disables it' );
	}

	public function test_fire_checkpoints_at_most_once_per_30s(): void {
		// The offsetlog is crash-resume only (not a position source — TopicProbe is),
		// so fire() checkpoints at most every CHECKPOINT_INTERVAL_S (30s), not every
		// poll. Each checkpoint appends one offsetlog entry, so entry-count == checkpoints.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$c = new class() extends Consumer_Node {
			public function probe_fire(): void {
				$this->fire();
			}
		};
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c );

		// One checkpoint = one segment (segment_size=1 keyframe timeline), so count
		// records across ALL segment files, not just 0.log.
		$entries = fn (): int => $this->count_offsetlog_records( "{$this->tmp}/offsets.p0" );

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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$node       = new Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'in_flight' => [ 'r1' => [ 'pad' => \str_repeat( 'x', 5000 ) ] ] ];

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$c->set_snapshot_node( 'request-builder' );
		$this->pump_consumer( $c );
		$c->checkpoint();

		// Old worker process dies; the offsetlog file (with the cache) persists.
		Core::reset();

		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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

	public function test_boot_checkpoint_preserves_snapshot_cache_on_disk(): void {
		// The boot-bump checkpoint runs BEFORE the snapshot is restored. It must not
		// co-commit the un-restored (empty) node state, or it would clobber the good
		// cache in the newest frame — a crash right after boot (before the next real
		// checkpoint) would then restore EMPTY and lose the in-flight state. So the
		// bumped attempt is recorded statelessly before restore; the cache is
		// re-committed to a fresh frame after restore. The newest DISK frame must
		// therefore still carry the cache.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$node        = new Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'in_flight' => [ 'r1' => 'keep-me' ] ];

		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->name( 'firehose:consumer' );
		$a->sink( new Capture_Sink_Node() );
		$a->set_snapshot_node( 'request-builder' );
		$this->pump_consumer( $a );
		$a->checkpoint();

		Core::reset(); // old worker dies; offsetlog (with cache) persists.

		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->name( 'firehose:consumer' );
		$b->sink( new Capture_Sink_Node() );
		$b->set_snapshot_node( 'request-builder' );
		$node2 = new Snapshot_Probe();
		$node2->name( 'request-builder' );
		$this->pump_consumer( $b ); // poll_init: stateless boot frame → restore → stateful boot frame.

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame(
			[ 'in_flight' => [ 'r1' => 'keep-me' ] ],
			$entry['cache'] ?? null,
			'the newest on-disk frame after a stateful boot must carry the restored cache, not an empty pre-restore snapshot'
		);
	}

	public function test_boot_wipes_snapshot_cache_after_state_wipe_window(): void {
		// A crash streak older than STATE_WIPE_AFTER_S is a snapshot that keeps killing
		// us, not a poison message — no single message can be skipped to fix it. So the
		// boot DISCARDS the resumable cache (starts the node stateless) rather than
		// restoring the corrupt state and crashing again forever.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$node        = new Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'poison' => 'state' ];

		Core::$now = 1000.0;
		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->sink( new Capture_Sink_Node() );
		$a->set_snapshot_node( 'request-builder' );
		$this->pump_consumer( $a );
		$a->checkpoint(); // healthy frame with cache; first_crash_ts=null.

		Core::reset();
		Core::$now = 1000.0;
		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->sink( new Capture_Sink_Node() );
		$b->set_snapshot_node( 'request-builder' );
		( new Snapshot_Probe() )->name( 'request-builder' );
		$this->pump_consumer( $b ); // recovery boot → first_crash_ts=1000, attempts=2, cache still committed.

		// A fresh worker boots PAST the wipe window — the streak has run 901s.
		Core::reset();
		Core::$now = 1000.0 + Consumer_Node::STATE_WIPE_AFTER_S + 1.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$c->set_snapshot_node( 'request-builder' );
		$node3 = new Snapshot_Probe();
		$node3->name( 'request-builder' );
		$this->pump_consumer( $c );

		$this->assertSame( [], $node3->state, 'a crash streak past the wipe window must discard the snapshot cache, not restore it' );
	}

	public function test_boot_attempt_bump_survives_a_restore_crash(): void {
		// The bump is recorded STATELESS, before restore_state(). So a snapshot whose
		// restore throws still advances the durable counter — and because that frame
		// carries no cache, the next boot won't re-attempt the bad restore (self-heal).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'hello' );

		$node        = new Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'x' => 1 ];

		$a = new Consumer_Node();
		$a->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$a->sink( new Capture_Sink_Node() );
		$a->set_snapshot_node( 'request-builder' );
		$this->pump_consumer( $a );
		$a->checkpoint();

		Core::reset();
		$b = new Consumer_Node();
		$b->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$b->sink( new Capture_Sink_Node() );
		$b->set_snapshot_node( 'request-builder' );
		( new Throwing_Snapshot_Probe() )->name( 'request-builder' );

		try {
			$this->pump_consumer( $b ); // restore_state() throws mid-boot.
			$this->fail( 'expected the throwing restore to propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'restore boom', $e->getMessage() );
		}

		$entry = $this->newest_offsetlog_entry( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 2, $entry['attempts'], 'the bumped attempt must be durable even though restore crashed' );
		$this->assertArrayNotHasKey( 'cache', $entry, 'the pre-restore frame is stateless, so the next boot self-heals' );
	}

	public function test_restart_resumes_from_last_checkpoint(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap1 = new Capture_Sink_Node();
		$c1->sink( $cap1 );
		$this->pump_consumer( $c1 );
		$c1->checkpoint();
		unset( $c1 );

		$this->produce_line( $source, 'second' );

		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap2 = new Capture_Sink_Node();
		$c2->sink( $cap2 );
		$this->pump_consumer( $c2 );

		$this->assertCount( 1, $cap2->captured );
		$this->assertSame( 'second', $cap2->captured[0][ Message::VALUE ] );
	}

	public function test_has_checkpoint_false_without_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$this->assertFalse( $c->has_checkpoint() );
	}

	public function test_has_checkpoint_false_when_offsetlog_has_no_prior_entry(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$this->assertFalse( $c->has_checkpoint() );
	}

	public function test_has_checkpoint_true_after_resuming_from_offsetlog(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c1->sink( new Capture_Sink_Node() );
		$this->pump_consumer( $c1 );
		$c1->checkpoint();
		unset( $c1 );

		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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

		mkdir( "{$this->tmp}/data.p0", 0755, true );
		file_put_contents( "{$this->tmp}/data.p0/0.log", $half1 );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$c->poll();
		// No complete line yet — should emit nothing.
		$this->assertCount( 0, $cap->captured, 'partial line must NOT be emitted on first poll' );

		// Append the rest of the line.
		file_put_contents( "{$this->tmp}/data.p0/0.log", $half2, FILE_APPEND );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured, 'completed line must emit once fully written' );
		$this->assertSame( 'first', $cap->captured[0][ Message::VALUE ] );
		// Cursor should be at start of segment 0.
		$this->assertStringStartsWith( '0:0:', $cap->captured[0][ Message::ID ] );
	}

	public function test_partial_line_does_not_double_emit_bytes(): void {
		// Writer writes a packed line 1 byte at a time across multiple polls.
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::VALUE ]     = 'hello';
		$packed                    = Message::packed( $message ) . "\n";

		mkdir( "{$this->tmp}/data.p0", 0755, true );
		file_put_contents( "{$this->tmp}/data.p0/0.log", '' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		for ( $i = 0; $i < strlen( $packed ); $i++ ) {
			file_put_contents( "{$this->tmp}/data.p0/0.log", $packed[ $i ], FILE_APPEND );
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

		mkdir( "{$this->tmp}/data.p0", 0755, true );
		// Stream 21MB (no newlines) via per-MB chunks to keep per-allocation small.
		$fh    = fopen( "{$this->tmp}/data.p0/0.log", 'wb' );
		$chunk = str_repeat( 'x', 1048576 );
		for ( $i = 0; $i < 21; ++$i ) {
			fwrite( $fh, $chunk );
		}
		fclose( $fh );
		unset( $chunk );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Drain to EOF. Each poll reads one READ_BLOCK_BYTES block into the buffer;
		// once it crosses 20MB with no newline, the discard branch MUST fire.
		$this->pump_consumer( $c );

		$ref = new \ReflectionClass( $c );
		$rem_prop = $ref->getProperty( 'buffer' );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'old1' );
		$this->produce_line( $source, 'old2' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'alpha' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 32 4 86400" );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$count = count( $segments );
		$this->assertGreaterThanOrEqual( 2, $count );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( 'recent' );

		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$expected = $segments[ $count - 2 ]['id'];
		$this->assertSame( $expected, $seg_prop->getValue( $c ) );
	}

	public function test_empty_offsetlog_dir_skips_offsetlog(): void {
		// cli sessions and other ephemeral readers pass '' for offsetlog dir
		// to skip the offsetlog entirely — no per-session directories under
		// offsets/, no checkpoint persistence, just tail.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'hello', $cap->captured[0][ Message::VALUE ] );

		// checkpoint() must be a no-op in this mode — no offsetlog directory
		// should appear underneath $this->tmp.
		$c->checkpoint();
		$this->assertFalse( is_dir( "{$this->tmp}/offsets" ), 'no offsetlog dir created with empty offsetlog_dir' );
	}

	public function test_next_offset_explicit_array_position(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( [ 'seg' => 5, 'off' => 100 ] );

		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$this->assertSame( 5, $seg_prop->getValue( $c ) );
		$this->assertSame( 100, $off_prop->getValue( $c ) );
	}

	public function test_next_offset_array_clamps_negative_off_to_zero(): void {
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$ref = new \ReflectionClass( $c );
		$off = $ref->getProperty( 'cursor_off' );

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
		$source->arguments( "{$this->tmp}/data.p0 32 4 86400" );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertNotEmpty( $segments );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$off = $ref->getProperty( 'cursor_off' );

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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'after-wipe' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Stale checkpoint from before the wipe: same segment id (0), offset
		// far past the recreated segment's size, plus a leftover partial line.
		$stale_off = 5774576; // any value past the recreated segment's size
		$ref       = new \ReflectionClass( $c );
		$off       = $ref->getProperty( 'cursor_off' );
		$off->setValue( $c, $stale_off );
		$rem = $ref->getProperty( 'buffer' );
		$rem->setValue( $c, 'stale-partial' );

		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured, 'cursor past EOF of an existing segment must rewind and drain' );
		$this->assertSame( 'after-wipe', $cap->captured[0][ Message::VALUE ] );
		$this->assertStringStartsWith( '0:0:', $cap->captured[0][ Message::ID ], 'rewind must restart at segment offset 0' );
	}

	public function test_handle_request_GET_LAG_reports_replay_when_cursor_past_eof(): void {
		// Companion to the recreated-segment recovery: a cursor past EOF means
		// the whole segment is pending replay. GET_LAG must say so instead of
		// clamping to bytes_behind=0 / caught_up=true (which masked a wedged
		// consumer as healthy).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'after-wipe' );
		$segment_size = (int) $source->get_segments( true )[0]['size'];

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Stale cursor past EOF, plus a stale partial line LONGER than the
		// recreated segment — the old remainder subtraction would clamp
		// bytes_behind back to 0 and re-mask the wedge.
		$stale_off = 5774576; // any value past the recreated segment's size
		$ref       = new \ReflectionClass( $c );
		$off       = $ref->getProperty( 'cursor_off' );
		$off->setValue( $c, $stale_off );
		$rem = $ref->getProperty( 'buffer' );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'after-wipe' );
		$segment_size = (int) $source->get_segments( true )[0]['size'];

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
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
		$source->arguments( "{$this->tmp}/data.p0 32 4 86400" );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ), 'need multiple segments' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$this->assertSame( (int) end( $segments )['id'], $seg->getValue( $c ) );
	}

	public function test_poll_stamps_message_FROM_with_consumer_name(): void {
		// FROM-stamping is a required convention — every emitted message must
		// have the Consumer's name stamped onto FROM so downstream nodes can
		// reply via TO=FROM.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hi' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'real-name' );
		$c->set_stamp_as( '_repl' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( '_repl', $cap->captured[0][ Message::FROM ], 'override must replace name in FROM' );
	}

	public function test_poll_emitted_ID_is_segment_offset_length(): void {
		// Each emitted message's ID = "{segment}:{offset}:{length}" — offset is the record's
		// start, length its on-disk byte span (incl. newline). A hub's SSE_In resumes at
		// offset+length (the exact next boundary); it can't derive the on-disk length from the
		// re-stamped wire bytes, so the producing Consumer — which read the bytes — stamps it.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 2, $cap->captured );
		[ $segment1, $offset1, $length1 ] = explode( ':', $cap->captured[0][ Message::ID ] );
		$this->assertSame( '0', $segment1 );
		$this->assertSame( '0', $offset1 );
		[ $segment2, $offset2, $length2 ] = explode( ':', $cap->captured[1][ Message::ID ] );
		$this->assertSame( '0', $segment2 );
		// The first record's length is exactly the second record's start offset — proving
		// length is the on-disk span (offset + length = the next record's boundary).
		$this->assertGreaterThan( 0, (int) $length1 );
		$this->assertSame( (int) $length1, (int) $offset2, 'length is the on-disk span to the next record' );
	}

	public function test_poll_preserves_producer_KEY(): void {
		// Consumer MUST NOT overwrite the producer's KEY. KEY is the routing
		// key — rid for firehose entries, handler for jobintake. Overwriting
		// it to seg:offset (as Consumer used to do) breaks RequestBuilder's
		// rid grouping and any multi-partition queue keyed on handler.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::KEY ]       = 'producer-key-abc123';
		$message[ Message::VALUE ]     = 'hello';
		$source->fill( $message );
		$source->flush();

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->pump_consumer( $c );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'producer-key-abc123', $cap->captured[0][ Message::KEY ] );
		// Position breadcrumb lands on ID alongside.
		$this->assertStringStartsWith( '0:0:', $cap->captured[0][ Message::ID ] );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::TO ]        = '_sse/browser-99';
		$message[ Message::VALUE ]     = 'reply';
		$source->fill( $message );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		mkdir( "{$this->tmp}/offsets.p0", 0755, true );

		// Message with VALUE = string "garbage" (not an array with seg/off).
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = 1234567890.0;
		$message[ Message::VALUE ]     = 'garbage';
		file_put_contents( "{$this->tmp}/offsets.p0/0.log", Message::packed( $message ) . "\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );

		// Cursor must remain at the constructor default (0/0) when the offsetlog
		// entry's VALUE doesn't match the expected schema.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$off = $ref->getProperty( 'cursor_off' );

		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
	}

	public function test_load_offsetlog_skips_when_only_blank_lines(): void {
		// A segment that contains only newlines (no JSON-encoded packed message)
		// must be ignored — array_filter strips them and load_offsetlog returns
		// without seeding the cursor.
		mkdir( "{$this->tmp}/offsets.p0", 0755, true );
		file_put_contents( "{$this->tmp}/offsets.p0/0.log", "\n\n\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$off = $ref->getProperty( 'cursor_off' );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$path  = "{$this->tmp}/offsets.p0/0.log";
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'first' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$count1 = $this->count_offsetlog_records( "{$this->tmp}/offsets.p0" );

		$this->produce_line( $source, 'second' );
		$c->poll();
		$c->checkpoint();
		$count2 = $this->count_offsetlog_records( "{$this->tmp}/offsets.p0" );

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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'fired' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Invoke protected fire() via reflection. Each fire() drains the prior
		// block then reads one more, so the first fire reads 'fired' into the
		// buffer and the second drains it.
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->invoke( $c );
		$fire->invoke( $c );

		$this->assertCount( 1, $cap->captured, 'fire() must drain via poll()' );
		$this->assertSame( 'fired', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_fire_writes_first_checkpoint_on_initial_call(): void {
		// On the FIRST fire(), last_checkpoint=0 so (now - 0) >= 1 always
		// holds — checkpoint() must run (provided the cursor advanced).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'cp' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$ref = new \ReflectionClass( $c );

		Core::$now = \microtime(true); // Ensure now is a real wall-clock value.

		$fire = $ref->getMethod( 'fire' );
		$fire->invoke( $c );

		$this->assertFileExists(
			"{$this->tmp}/offsets.p0/0.log",
			'fire() with stale last_checkpoint must invoke checkpoint()'
		);

		// last_checkpoint should now be set to the current wall-clock time.
		$last = $ref->getProperty( 'last_checkpoint' );
		$this->assertGreaterThan( 0.0, $last->getValue( $c ) );
	}

	public function test_fire_skips_checkpoint_when_within_interval(): void {
		// Spec: "Persist cursor every CHECKPOINT_INTERVAL_S so a respawning
		// worker resumes from the last commit." Within that interval, fire()
		// must NOT call checkpoint() — even if data was polled.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->sink( new Capture_Sink_Node() );
		$ref = new \ReflectionClass( $c );

		// Pre-set last_checkpoint to "right now" so the interval gate fails.
		Core::$now = \microtime(true);
		$last = $ref->getProperty( 'last_checkpoint' );
		$last->setValue( $c, Core::$now );

		// Pre-set checkpoint_seg/off to match cursor so checkpoint() would skip
		// even if it WAS called — but more importantly, our test asserts the
		// caller of checkpoint() (fire) is gated by the interval.
		$cp_seg = $ref->getProperty( 'checkpoint_seg' );
		$cp_off = $ref->getProperty( 'checkpoint_off' );
		// Force divergent values so if checkpoint() runs, it WOULD write.
		$cp_seg->setValue( $c, -999 );
		$cp_off->setValue( $c, -999 );

		$fire = $ref->getMethod( 'fire' );
		$fire->invoke( $c );

		$this->assertFileDoesNotExist(
			"{$this->tmp}/offsets.p0/0.log",
			'within CHECKPOINT_INTERVAL_S, fire must not invoke checkpoint'
		);
	}

	public function test_fire_does_not_invoke_checkpoint_when_offsetlog_disabled(): void {
		// Consumer constructed with empty offsetlog_dir → no offsetlog
		// directory ever created, even after fire().
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$c->sink( new Capture_Sink_Node() );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
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
				$p->setValue( $this, false );
			}
		};
		$busy_consumer->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $busy_consumer );
		$fire = $ref->getMethod( 'fire' );
		$fire->invoke( $busy_consumer );

		// Inspect the EventFramework's timers map — fire() should have re-armed
		// with POLL_INTERVAL_BUSY_MS (=0) so the next tick drains immediately.
		$ef       = Event_Framework::instance();
		$ef_ref   = new \ReflectionClass( $ef );
		$timers_p = $ef_ref->getProperty( 'timers' );
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
		// path that powers the GET_LAG verb.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'one' );
		$this->produce_line( $source, 'two' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'my-consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                       = Message::new_message();
		$req[ Message::TYPE ]      = Message::TM_REQUEST;
		$req[ Message::FROM ]      = 'asker';
		$req[ Message::ID ]        = 'req-1';
		$req[ Message::KEY ]       = 'k';
		$req[ Message::VALUE ]     = 'GET_LAG';
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
		$this->assertSame( 'GET_LAG', $reply[ Message::VALUE ]['verb'] );
		$this->assertIsArray( $reply[ Message::VALUE ]['data'] );
	}

	public function test_handle_request_GET_LAG_returns_caught_up_when_empty(): void {
		// Spec: GET_LAG reply payload for an empty source partition has
		// bytes_behind=0, segments_behind=0, caught_up=true.
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'pending' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$source->arguments( "{$this->tmp}/data.p0 32 4 86400" );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ), 'need multi-segment for this test' );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Park cursor at oldest segment, offset 0 — every newer segment is
		// behind.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setValue( $c, (int) $segments[0]['id'] );
		$off = $ref->getProperty( 'cursor_off' );
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );

		// Pretend we already have 3 bytes buffered (already read).
		$ref = new \ReflectionClass( $c );
		$rem = $ref->getProperty( 'buffer' );
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
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		// "get_lag extra args" → GET_LAG.
		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = '  get_lag trailing args ignored  ';
		$c->fill( $req );

		$reply = $cap->captured[0];
		$this->assertSame( 'GET_LAG', $reply[ Message::VALUE ]['verb'] );
		$data = $reply[ Message::VALUE ]['data'];
		// GET_LAG shape (not the error shape) — verifies the verb was
		// recognized after trim+upper+arg-strip.
		$this->assertArrayHasKey( 'bytes_behind', $data );
	}

	public function test_handle_request_reply_uses_stamp_override_in_FROM(): void {
		// IPC input Consumer (cli/scaffolding case): set_stamp_as('_repl') —
		// the request reply's FROM must use the override, NOT the underlying
		// name. Otherwise replies wouldn't route through the worker's _repl
		// Partition.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'real-name' );
		$c->set_stamp_as( '_repl' );

		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'cli';
		$req[ Message::VALUE ] = 'GET_LAG';
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

		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
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

		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
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
		$ref->setValue( $tee, [ '', 'real' ] );

		$real = new Capture_Sink_Node();
		$real->name( 'real' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
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
		$ref->setValue( $tee, 'unexpected-string' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		// Call resolve_downstream_targets directly via reflection so we test
		// just this branch in isolation.
		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
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

		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tap' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
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
		$ref->setValue( $tap, 'unexpected-string' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tap' );
		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
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
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );

		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );

		$this->assertSame( [], $rdt->invoke( $c ), 'no target → empty list' );
	}

	public function test_resolve_downstream_targets_handles_non_Tee_target_class(): void {
		// Target resolves to a non-Tee node — single-row `{name, class}` with
		// the actual node's ShortName.
		$processor = new Capture_Sink_Node();
		$processor->name( 'just-a-processor' );

		$source = new Partition_Node();

		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'data' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'just-a-processor' );
		$c->sink( new Capture_Sink_Node() );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
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
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'one' );
		$this->produce_line( $source, 'two' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$c->arguments( "{$this->tmp}/data.p2 {$this->tmp}/offsets.p2" );
		$this->assertSame(
			"{$this->tmp}/data.p2 {$this->tmp}/offsets.p2",
			$c->arguments()
		);
	}

	public function test_constructor_ephemeral_mode_records_empty_offsetlog_in_arguments(): void {
		// Ephemeral consumer (no offsetlog) — arguments still reflect the
		// trailing empty string so the make_node round-trip is unambiguous.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$this->assertSame( "{$this->tmp}/data.p0 ", $c->arguments() );
	}

	// ============================================================================
	// node_schema() — palette manifest for the topology console.
	// ============================================================================

	public function test_node_schema_declares_io_category_and_request_verbs(): void {
		// Topology console reads node_schema() to render the palette entry.
		// Consumer is in the I/O category and declares one request verb (GET_LAG)
		// — surfaceable in the topology editor as an introspection request an
		// operator can fire from the canvas. The other read verbs were folded into
		// dump_metadata.
		$schema = Consumer_Node::node_schema();
		$this->assertIsArray( $schema );
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertNotSame( '', $schema['description'] );
		$this->assertIsArray( $schema['arguments'] );
		$this->assertIsArray( $schema['commands'] );
		$this->assertSame(
			[ 'set_snapshot_node', 'set_line_mode', 'SEEK_FRAME', 'PAUSE', 'PLAY', 'STEP', 'set_multi_writer' ],
			\array_column( $schema['commands'], 'name' ),
			'Consumer exposes the snapshot-cache + line-mode config verbs, the time-travel transport (STEP is a mutating command, not a request), and set_multi_writer (seal-grace)'
		);

		// Three ctor params: source_dir (required), offsetlog_dir + deadletter_dir (default '').
		$this->assertCount( 3, $schema['arguments'] );
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame(
			[ 'source_dir', 'offsetlog_dir', 'deadletter_dir' ],
			$names
		);

		// Request verbs are READ-ONLY. GET_OFFSET / LIST_FRAMES / READ_STATE were
		// folded into dump_metadata (its dump_metadata hook), leaving just
		// GET_LAG. STEP is NOT here — it mutates, so it's an auth-gated command.
		$this->assertCount( 1, $schema['requests'] );
		$verbs = \array_column( $schema['requests'], 'name' );
		$this->assertContains( 'GET_LAG', $verbs );
		$this->assertNotContains( 'GET_OFFSET', $verbs, 'GET_OFFSET folded into dump_metadata' );
		$this->assertNotContains( 'LIST_FRAMES', $verbs, 'LIST_FRAMES folded into dump_metadata' );
		$this->assertNotContains( 'READ_STATE', $verbs, 'READ_STATE folded into dump_metadata' );
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
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( [ 'seg' => 7 ] );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$off = $ref->getProperty( 'cursor_off' );

		$this->assertSame( 7, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ), 'missing off must default to 0' );
	}

	public function test_next_offset_array_defaults_seg_to_zero_when_missing(): void {
		// Explicit-array form: off=42 with no 'seg' key. Defaults to 0.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( [ 'off' => 42 ] );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$off = $ref->getProperty( 'cursor_off' );

		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 42, $off->getValue( $c ) );
	}

	public function test_next_offset_recent_with_single_segment_picks_that_one(): void {
		// 'recent' fallback: when there's only ONE segment, pick the oldest
		// (which is also the newest in that case). Distinct from the
		// already-tested multi-segment 'recent' path.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'only' );

		$segments = $source->get_segments( true );
		$this->assertCount( 1, $segments, 'precondition: single segment' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( 'recent' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$off_prop = $ref->getProperty( 'cursor_off' );

		$this->assertSame( $segments[0]['id'], $seg_prop->getValue( $c ), 'single-segment recent picks that segment' );
		$this->assertSame( 0, $off_prop->getValue( $c ), 'recent always resets off to 0' );
	}

	public function test_next_offset_end_with_no_segments_leaves_cursor_at_default(): void {
		// 'end' on an empty source must NOT crash and must NOT advance the
		// cursor (segments empty → switch case is a no-op).
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( 'end' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$off_prop = $ref->getProperty( 'cursor_off' );

		$this->assertSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ) );
	}

	public function test_next_offset_recent_with_no_segments_leaves_cursor_at_default(): void {
		// 'recent' on an empty source must early-exit cleanly.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->next_offset( 'recent' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$off_prop = $ref->getProperty( 'cursor_off' );

		$this->assertSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ) );
	}

	// ============================================================================
	// load_offsetlog() — early-return when offsetlog disabled.
	// ============================================================================

	public function test_load_offsetlog_null_guard_returns_when_offsetlog_unset(): void {
		// Direct exercise of the null guard inside load_offsetlog: a
		// Consumer constructed with offsetlog_dir='' leaves
		// $this->offsetlog at null. Calling load_offsetlog() (via reflection)
		// must return immediately without touching the filesystem.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );

		$ref    = new \ReflectionMethod( Consumer_Node::class, 'load_offsetlog' );
		$ref->invoke( $c );

		// Cursor stays at default; no offsets directory appears.
		$rc      = new \ReflectionClass( $c );
		$seg     = $rc->getProperty( 'cursor_seg' );
		$off     = $rc->getProperty( 'cursor_off' );
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
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Force at_eof to false so we can verify poll() flips it back.
		$ref    = new \ReflectionClass( $c );
		$at_eof = $ref->getProperty( 'at_eof' );
		$at_eof->setValue( $c, false );

		$c->poll();

		$this->assertCount( 0, $cap->captured );
		$this->assertTrue( $at_eof->getValue( $c ), 'empty source sets at_eof' );
	}

	public function test_poll_skips_segments_older_than_cursor(): void {
		// Cursor parked on a newer segment must skip older segments in the
		// poll loop. The `$s['id'] < $this->cursor_seg → continue` branch.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 32 4 86400" );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ) );

		$c   = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// Park cursor at NEWEST segment, off=size so nothing to read.
		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$off_prop = $ref->getProperty( 'cursor_off' );

		$newest = \end( $segments );
		$seg_prop->setValue( $c, (int) $newest['id'] );
		$off_prop->setValue( $c, (int) $newest['size'] );

		$c->poll();

		$this->assertCount( 0, $cap->captured, 'no new bytes → no emissions' );
		// at_eof should be true after poll.
		$at_eof_prop = $ref->getProperty( 'at_eof' );
		$this->assertTrue( $at_eof_prop->getValue( $c ) );
	}

	public function test_poll_skips_line_that_fails_unpacked_and_continues(): void {
		// A genuinely corrupt on-disk line (here a too-few-fields array that
		// Message::unpacked() rejects) followed by a valid packed line. The drain
		// loop must skip the bad line and still emit the following valid one, not
		// abort the poll. Written raw because packed() now slices to 7 fields, so
		// it can no longer be coaxed into emitting a malformed line itself.
		$seg_dir = "{$this->tmp}/data.p0";
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		@\mkdir( $seg_dir, 0755, true );

		$good                   = Message::new_message();
		$good[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$good[ Message::VALUE ] = 'keepme';
		\file_put_contents( "{$seg_dir}/0.log", "[1,2,3]\n" . Message::packed( $good ) . "\n" );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$capture = new Capture_Sink_Node();
		$c->sink( $capture );

		$this->pump_consumer( $c );

		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $capture->captured );
		$this->assertSame( [ 'keepme' ], $values );
	}

	public function test_construct_ignores_unparseable_offsetlog_entry(): void {
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_line( $source, 'hello' );

		// Write a real checkpoint, then corrupt that entry in place at the same
		// byte length (segment size unchanged) so it is a complete-but-
		// unparseable offsetlog line. A fresh Consumer must seed past it without
		// throwing, starting from the default cursor (0/0).
		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c1->sink( new Capture_Sink_Node() );
		$c1->poll();
		$c1->checkpoint();
		unset( $c1 );

		$offsetlog_path = "{$this->tmp}/offsets.p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$nl             = \strpos( $content, "\n" );
		\file_put_contents( $offsetlog_path, \str_repeat( 'x', (int) $nl ) . \substr( $content, (int) $nl ) );
		\clearstatcache();

		$c2  = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$ref = new \ReflectionObject( $c2 );
		$seg = $ref->getProperty( 'cursor_seg' );
		$off = $ref->getProperty( 'cursor_off' );
		$this->assertSame( 0, $seg->getValue( $c2 ) );
		$this->assertSame( 0, $off->getValue( $c2 ) );
	}

	public function test_named_consumer_registers_source_sibling(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$c->name( 'feed' );
		$this->assertSame( $c, Core::node( 'feed' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:source' ) );
	}

	public function test_named_consumer_registers_offsetlog_sibling_when_offsetlog_set(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'feed' );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:source' ) );
		$this->assertInstanceOf( Partition_Node::class, Core::node( 'feed:offsetlog' ) );
	}

	public function test_consumer_without_offsetlog_does_not_register_offsetlog_sibling(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 " );
		$c->name( 'feed' );
		$this->assertNull( Core::node( 'feed:offsetlog' ) );
	}

	public function test_renaming_consumer_renames_children_and_unregisters_old_names(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'feed' );
		$this->expectException( \RuntimeException::class );
		$c->name( null );
	}

	public function test_naming_consumer_empty_string_throws(): void {
		// '' is the other "no value" input — name('') throws too.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'feed' );
		$this->expectException( \RuntimeException::class );
		$c->name( '' );
	}

	public function test_remove_node_unregisters_self_and_children(): void {
		// remove_node() (not name(null)) is the teardown path; it cascades to
		// both Partition children.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$c->arguments( "{$this->tmp}/data.p0 " );
		$this->expectException( \RuntimeException::class );
		$c->name( 'feed' );
	}

	public function test_sink_cascades_to_both_children(): void {
		$downstream = new Capture_Sink_Node();
		$c          = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'feed' );
		$c->sink( $downstream );
		$this->assertSame( $downstream, Core::node( 'feed:source' )->sink() );
		$this->assertSame( $downstream, Core::node( 'feed:offsetlog' )->sink() );
		$this->assertSame( $downstream, $c->sink() );
	}

	public function test_remove_node_removes_both_children(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'feed' );
		$c->remove_node();
		$this->assertNull( Core::node( 'feed' ) );
		$this->assertNull( Core::node( 'feed:source' ) );
		$this->assertNull( Core::node( 'feed:offsetlog' ) );
	}

	public function test_consumer_named_zero_registers_zero_prefixed_children(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$c->arguments( "{$this->tmp}/data.p0 " );
		$c->name( 'feed' );

		$source = Core::node( 'feed:source' );
		$this->assertInstanceOf( Partition_Node::class, $source );
		$this->assertSame( 'feed:source', $source->name() );
		$this->assertSame( $c, $source->patron(), 'source must mark the Consumer as its patron' );
	}

	public function test_offsetlog_sibling_is_named_and_patron_set_to_consumer(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
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
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'feed' );
		$c->sink( $downstream );

		$this->assertSame( $downstream, Core::node( 'feed:source' )->sink() );
		$this->assertSame( $downstream, Core::node( 'feed:offsetlog' )->sink() );
		$this->assertNotSame( $interpreter, Core::node( 'feed:source' )->sink() );
		$this->assertNotSame( $interpreter, Core::node( 'feed:offsetlog' )->sink() );
	}

	/**
	 * The time-travel transport verbs (SEEK_FRAME/PAUSE/PLAY/STEP) are driven by
	 * the Inspector's Time Travel bar, so they carry hidden:true to keep them out
	 * of the generic per-command verb-button list. Non-transport config verbs
	 * (set_snapshot_node, set_line_mode) stay visible.
	 */
	public function test_node_schema_marks_time_travel_verbs_hidden(): void {
		$commands = [];
		foreach ( Consumer_Node::node_schema()['commands'] as $command ) {
			$commands[ $command['name'] ] = $command;
		}

		foreach ( [ 'SEEK_FRAME', 'PAUSE', 'PLAY', 'STEP' ] as $verb ) {
			$this->assertArrayHasKey( $verb, $commands, "{$verb} must be a Consumer command" );
			$this->assertTrue( $commands[ $verb ]['hidden'] ?? false, "{$verb} must be hidden from the generic verb list" );
		}

		foreach ( [ 'set_snapshot_node', 'set_line_mode' ] as $verb ) {
			$this->assertArrayHasKey( $verb, $commands, "{$verb} must be a Consumer command" );
			$this->assertArrayNotHasKey( 'hidden', $commands[ $verb ], "{$verb} must stay visible" );
		}
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

/** A snapshot node whose restore crashes — proves the pre-restore bump is durable. */
class Throwing_Snapshot_Probe extends Node {
	public function save_state(): array {
		return [];
	}
	public function restore_state( array $saved ): void {
		throw new \RuntimeException( 'restore boom' );
	}
}

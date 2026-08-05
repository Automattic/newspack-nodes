<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Log_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Log_Node::class )]
class LogTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function bytestream( string $value ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $value;
		return $message;
	}

	/** fill() takes the message array by reference, so it must be a variable, not an inline call result. */
	private function write_value( \Newspack_Nodes\Node $node, string $value ): void {
		$message = $this->bytestream( $value );
		$node->fill( $message );
	}

	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		// Args: file segment_size min_segments num_segments [min_lifetime] [lifetime] [max_segments]. Lazy fopen.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log", "1024", "2", "3" ] );
		$ref = new \ReflectionClass( $log );
		$this->assertSame( "{$this->tmp}/out.log", $ref->getProperty( 'file' )->getValue( $log ) );
		$this->assertSame( 1024, $ref->getProperty( 'segment_size' )->getValue( $log ) );
		$this->assertSame( 3,    $ref->getProperty( 'num_segments' )->getValue( $log ) );
		$this->assertNull( $ref->getProperty( 'fh' )->getValue( $log ), 'handle is opened lazily on first write' );
	}

	public function test_arguments_accepts_optional_lifetime_tokens(): void {
		// Log inherits Partition's dual-rule cleanup; the two lifetime knobs are
		// optional trailing args (default 0) so age retention is configurable too.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log", "1024", "2", "3", "0", "100", "200" ] );
		$ref = new \ReflectionClass( $log );
		$this->assertSame( 100, $ref->getProperty( 'min_lifetime' )->getValue( $log ) );
		$this->assertSame( 200, $ref->getProperty( 'lifetime' )->getValue( $log ) );
	}

	public function test_arguments_resolves_config_defaults_for_missing_optional_tokens(): void {
		// Optional args default to <config:*> tokens, resolved from config and
		// coerced to int; 1024/2 are the test-config values, distinct from the
		// DEFAULT_* constants (67108864/4) they used to fall back to.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$ref = new \ReflectionClass( $log );
		$this->assertSame( 1024, $ref->getProperty( 'segment_size' )->getValue( $log ) );
		$this->assertSame( 2,    $ref->getProperty( 'num_segments' )->getValue( $log ) );
	}

	public function test_fill_writes_raw_value_not_packed_envelope(): void {
		// Log serializes the VALUE verbatim — no Message::packed framing, no added newline.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$this->write_value( $log, "hello\n" );
		$log->flush();

		$this->assertSame( "hello\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
		$this->assertFileDoesNotExist( "{$this->tmp}/out.log", 'no bare file — segments are {file}.{seg}' );
	}

	public function test_fill_accumulates_multiple_values_in_one_segment(): void {
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log", "1048576", "2", "2" ] ); // large segment: both land in .0
		$this->write_value( $log, "first\n" );
		$this->write_value( $log, "second\n" );
		$log->flush();

		$this->assertSame( "first\nsecond\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_creates_missing_parent_directory(): void {
		$path = "{$this->tmp}/nested/sub/out.log";
		$log  = new Log_Node();
		$log->arguments( [ $path ] );
		$this->write_value( $log, "x\n" );
		$log->flush();

		$this->assertSame( "x\n", \file_get_contents( "{$path}.0" ) );
	}

	public function test_partition_dir_reports_the_segment_directory(): void {
		// Log inherits partition_dir() but its segments live beside the file, so it
		// must report dirname(file) (not the empty base partition_dir) — Tail's
		// get_batch() stat-defeats on this path.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/sub/out.log" ] );
		$this->assertSame( "{$this->tmp}/sub", $log->partition_dir() );
	}

	public function test_segment_size_rolls_to_next_monotonic_segment(): void {
		// segment_size=10: the second write crosses the cap and rotates to .1.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log", "10", "2", "4" ] );
		$this->write_value( $log, "0123456789\n" ); // 11 bytes → lands in .0
		$log->flush();
		$this->write_value( $log, "after\n" );       // .0 is over cap → rotate to .1
		$log->flush();

		$this->assertSame( "0123456789\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
		$this->assertSame( "after\n",      \file_get_contents( "{$this->tmp}/out.log.1" ) );
	}

	public function test_num_segments_retention_prunes_oldest(): void {
		// num_segments=2, min_lifetime default 0 (count rule always fires) → keep 2 newest.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log", "1", "2", "2" ] ); // segment_size=1 → every write rotates
		foreach ( [ 'a', 'b', 'c', 'd' ] as $v ) {
			$this->write_value( $log, $v );
			$log->flush();
		}

		// 4 writes → segments 0..3; retention keeps the 2 highest ids.
		$this->assertFileDoesNotExist( "{$this->tmp}/out.log.0" );
		$this->assertFileDoesNotExist( "{$this->tmp}/out.log.1" );
		$this->assertFileExists( "{$this->tmp}/out.log.2" );
		$this->assertFileExists( "{$this->tmp}/out.log.3" );
	}

	public function test_TM_ERROR_is_dropped(): void {
		// Control plane, not data — must not pollute the log. Mirrors Tachikoma Log.pm:69.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_ERROR;
		$message[ Message::VALUE ] = 'this should NOT land';
		$log->fill( $message );
		$log->flush();

		$this->assertFileDoesNotExist( "{$this->tmp}/out.log.0" );
	}

	public function test_TM_EOF_is_dropped_and_keeps_node_writable(): void {
		// Append-only: EOF is a producer-shutdown signal; Log expects more data later
		// and must NOT close/remove the node (overwrite mode is gone).
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$log->name( 'mylog' );
		$this->write_value( $log, "before-eof\n" );

		$eof                  = Message::new_message();
		$eof[ Message::TYPE ] = Message::TM_EOF;
		$log->fill( $eof );

		$this->assertNotNull( \Newspack_Nodes\Core::node( 'mylog' ), 'EOF must not remove the node' );
		$this->write_value( $log, "after-eof\n" );
		$log->flush();

		$this->assertSame( "before-eof\nafter-eof\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_TM_REQUEST_is_dropped(): void {
		// Control plane: a request is not data and must not be written. Rotation is
		// size-driven (segment_size), so Log has no rotate request.
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::VALUE ] = 'rotate';
		$log->fill( $req );
		$log->flush();

		$this->assertFileDoesNotExist( "{$this->tmp}/out.log.0" );
	}

	public function test_value_over_pipe_buf_is_dropped_without_void_warranty(): void {
		// Log inherits Partition's 4KB PIPE_BUF cap (atomic-write discipline, ADR-4).
		// An oversize VALUE is dropped, NOT written — a deliberate
		// change from the old uncapped Log. Operators opt out via void_warranty().
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$this->write_value( $log, \str_repeat( 'x', Partition_Node::MAX_LINE_SIZE + 1 ) );
		$log->flush();

		$this->assertFileDoesNotExist( "{$this->tmp}/out.log.0" );
	}

	public function test_void_warranty_lifts_cap_for_large_value(): void {
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log" ] );
		$log->void_warranty();
		$big = \str_repeat( 'y', Partition_Node::MAX_LINE_SIZE + 100 );
		$this->write_value( $log, $big );
		$log->flush();

		$this->assertSame( $big, \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_make_node_through_REPL_works_with_only_file(): void {
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make', [ 'Log', 'mylog', "{$this->tmp}/out.log" ] );

		$node = \Newspack_Nodes\Core::node( 'mylog' );
		$this->assertInstanceOf( Log_Node::class, $node );
		$this->write_value( $node, "default\n" );
		$node->flush();

		$this->assertSame( "default\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_dump_config_round_trips_ctor_args(): void {
		$log = new Log_Node();
		$log->arguments( [ "{$this->tmp}/out.log", "4096", "2", "5" ] );
		$log->name( 'mylog' );

		$out = $log->dump_config();
		$this->assertStringContainsString( 'make_node Log mylog', $out );
		$this->assertStringContainsString( "{$this->tmp}/out.log", $out );
		$this->assertStringContainsString( '4096', $out );
		$this->assertStringContainsString( '5', $out );
	}

	public function test_node_schema_arguments_are_file_segment_size_and_retention_knobs(): void {
		$args  = Log_Node::node_schema()['arguments'];
		$names = \array_column( $args, 'name' );
		$this->assertSame( [ 'file', 'segment_size', 'min_segments', 'num_segments', 'max_segments', 'min_lifetime', 'lifetime' ], $names );
	}

	public function test_node_schema_inherits_large_write_verbs_and_is_terminal(): void {
		$schema     = Log_Node::node_schema();
		$verb_names = \array_column( $schema['commands'] ?? [], 'name' );
		$this->assertContains( 'allow_large_writes', $verb_names ); // inherited from Partition
		$this->assertContains( 'void_warranty', $verb_names );
		$this->assertFalse( $schema['has_target'] ?? true );
		$this->assertTrue( $schema['accepts_fill'] ?? false );
	}

	public function test_unwritable_path_degrades_without_fatal(): void {
		// Parent is a regular file → mkdir + fopen both fail; fill()/flush() must not fatal.
		$blocker = "{$this->tmp}/blocker";
		\file_put_contents( $blocker, 'x' );
		$path = "{$blocker}/out.log";

		\set_error_handler( static fn (): bool => true, \E_WARNING );
		try {
			$log = new Log_Node();
			$log->arguments( [ $path ] );
			$this->write_value( $log, "y\n" );
			$log->flush();
			$this->assertFileDoesNotExist( "{$path}.0" );
		} finally {
			\restore_error_handler();
		}
	}
}

<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Log_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

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

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns filename / mode / max_size / max_rotations.
	 * Defaults: mode='append', max_size=0, max_rotations=0.
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log overwrite 1024 3" );
		$ref = new \ReflectionClass( $log );
		$this->assertSame( "{$this->tmp}/out.log", $ref->getProperty( 'filename' )->getValue( $log ) );
		$this->assertSame( 'overwrite',            $ref->getProperty( 'mode' )->getValue( $log ) );
		$this->assertSame( 1024,                   $ref->getProperty( 'max_size' )->getValue( $log ) );
		$this->assertSame( 3,                      $ref->getProperty( 'max_rotations' )->getValue( $log ) );
		// File handle opens immediately so the first fill() lands without delay.
		$this->assertTrue( \is_resource( $ref->getProperty( 'fh' )->getValue( $log ) ) );
		$log->remove_node();
	}

	public function test_arguments_setter_applies_schema_defaults_for_missing_optional_tokens(): void {
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$ref = new \ReflectionClass( $log );
		$this->assertSame( Log_Node::MODE_APPEND, $ref->getProperty( 'mode' )->getValue( $log ) );
		$this->assertSame( 0,                     $ref->getProperty( 'max_size' )->getValue( $log ) );
		$this->assertSame( 0,                     $ref->getProperty( 'max_rotations' )->getValue( $log ) );
		$log->remove_node();
	}

	public function test_fill_appends_value_to_file(): void {
		// Plain TM_BYTESTREAM: fill writes VALUE to the configured file.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = "hello\n";
		$log->fill( $msg );

		$log->remove_node(); // close handle so file_get_contents sees the bytes.
		$this->assertSame( "hello\n", \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_creates_missing_parent_directory(): void {
		// A configured path whose parent dir does not exist must be created
		// (mkdir -p) so the first write lands — not silently dropped on a failed
		// fopen until someone hand-creates the dir.
		$path = "{$this->tmp}/nested/sub/out.log";
		$log  = new Log_Node();
		$log->arguments( "{$path}" );
		$msg  = $this->bytestream( "x\n" );
		$log->fill( $msg );
		$log->remove_node();

		$this->assertFileExists( $path );
		$this->assertSame( "x\n", \file_get_contents( $path ) );
	}

	public function test_fill_accumulates_multiple_values(): void {
		// Subsequent fills append, not overwrite.
		$log   = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$one   = $this->bytestream( "first\n" );
		$two   = $this->bytestream( "second\n" );
		$log->fill( $one );
		$log->fill( $two );
		$log->remove_node();

		$this->assertSame( "first\nsecond\n", \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_TM_EOF_in_append_mode_is_dropped(): void {
		// EOF is a producer-shutdown signal; an append-mode log expects MORE
		// data later (e.g., a daily log file shared across processes), so it
		// must NOT close the file or remove the node.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$one = $this->bytestream( "before-eof\n" );
		$log->fill( $one );

		$eof                  = Message::new_message();
		$eof[ Message::TYPE ] = Message::TM_EOF;
		$log->fill( $eof );

		// Node still in registry → can write again.
		$two = $this->bytestream( "after-eof\n" );
		$log->fill( $two );
		$log->remove_node();

		$this->assertSame(
			"before-eof\nafter-eof\n",
			\file_get_contents( "{$this->tmp}/out.log" )
		);
	}

	public function test_TM_EOF_in_overwrite_mode_removes_node(): void {
		// Overwrite mode is single-shot (e.g., capture one report to a file).
		// EOF marks "producer is done" — close the file via remove_node so
		// the FD doesn't linger past the capture.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log overwrite" );
		$log->name( 'mylog' );
		$one = $this->bytestream( "single shot\n" );
		$log->fill( $one );

		$eof                  = Message::new_message();
		$eof[ Message::TYPE ] = Message::TM_EOF;
		$log->fill( $eof );

		// Node was removed: registry no longer has it.
		$this->assertNull( \Newspack_Nodes\Core::node( 'mylog' ) );
		$this->assertSame( "single shot\n", \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_max_size_triggers_automatic_rotate(): void {
		// max_size=10 → first 11-byte write fits the in-progress file, the
		// second triggers a rotate. Cumulative bytes track *total ever
		// written through this node*; once it crosses the threshold,
		// rotate() fires and the size counter resets.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log append 10" );

		// 11 bytes — already over threshold but rotate fires *after* the
		// write so the bytes are preserved in the rotated file.
		$msg = $this->bytestream( "0123456789\n" );
		$log->fill( $msg );
		// Second write goes to the freshly-opened file (post-rotate).
		$post = $this->bytestream( "after\n" );
		$log->fill( $post );
		$log->remove_node();

		// Current file has only the post-rotate bytes.
		$this->assertSame( "after\n", \file_get_contents( "{$this->tmp}/out.log" ) );

		// Pre-rotate file landed in the .0 rotation (logrotate-style).
		$this->assertFileExists( "{$this->tmp}/out.log.0" );
		$this->assertSame( "0123456789\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_rotate_once_moves_current_to_dot_zero_and_reopens_fresh(): void {
		// logrotate / /var/log style: rotate renames {filename} → {filename}.0
		// and reopens {filename} fresh (empty).
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$original = $this->bytestream( "original\n" );
		$log->fill( $original );
		$log->rotate();
		$fresh = $this->bytestream( "fresh\n" );
		$log->fill( $fresh );
		$log->remove_node();

		$this->assertSame( "original\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
		$this->assertSame( "fresh\n",    \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_rotate_twice_shifts_dot_zero_up_to_dot_one(): void {
		// Second rotate shifts the existing .0 up to .1 (highest-index-first,
		// no clobber) and the new newest rotation becomes .0.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );

		$first = $this->bytestream( "first\n" );
		$log->fill( $first );
		$log->rotate();                                   // first → .0
		$second = $this->bytestream( "second\n" );
		$log->fill( $second );
		$log->rotate();                                   // .0 → .1, second → .0
		$log->remove_node();

		$this->assertSame( "first\n",  \file_get_contents( "{$this->tmp}/out.log.1" ) );
		$this->assertSame( "second\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_rotated_state_reports_dot_zero_as_rotated_to(): void {
		// The ROTATED state's rotated_to is the new {filename}.0 path.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$log->name( 'mylog' );

		$msg = $this->bytestream( "x\n" );
		$log->fill( $msg );
		$log->rotate();

		// set_state caches the ROTATED payload; read it back via reflection.
		$ref       = new \ReflectionClass( $log );
		$set_state = $ref->getProperty( 'set_state' )->getValue( $log );
		$log->remove_node();

		$this->assertArrayHasKey( 'ROTATED', $set_state );
		$this->assertSame( "{$this->tmp}/out.log.0", $set_state['ROTATED']['rotated_to'] );
	}

	public function test_prune_ages_out_legacy_and_numeric_by_mtime(): void {
		// "leave + age out": prune globs BOTH the legacy date-named scheme
		// ({filename}-<date>) AND the new numeric scheme ({filename}.N), merges,
		// and keeps the max_rotations newest by mtime. A stale legacy file is
		// unlinked; a recent legacy file is kept alongside fresh .N files.
		\file_put_contents( "{$this->tmp}/out.log-2020-01-01-00:00:00-1", 'ancient' );
		\touch( "{$this->tmp}/out.log-2020-01-01-00:00:00-1", 1000 );
		\file_put_contents( "{$this->tmp}/out.log-2026-06-14-00:00:00-2", 'recent-legacy' );
		\touch( "{$this->tmp}/out.log-2026-06-14-00:00:00-2", 9000 );

		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log append 0 2" );
		$live = $this->bytestream( "live\n" );
		$log->fill( $live );
		$log->rotate();   // live → .0 (mtime = now, newest)
		$log->remove_node();

		// Candidates by mtime: ancient(1000) < recent-legacy(9000) < .0(now).
		// max=2 keeps the two newest → ancient legacy unlinked.
		$this->assertFileDoesNotExist( "{$this->tmp}/out.log-2020-01-01-00:00:00-1" );
		$this->assertFileExists( "{$this->tmp}/out.log-2026-06-14-00:00:00-2" );
		$this->assertFileExists( "{$this->tmp}/out.log.0" );
	}

	public function test_max_rotations_prunes_oldest_rotated_files(): void {
		// max_rotations=2 → after each rotate, only the 2 most recent
		// rotated siblings survive; older ones are unlinked. Matches the
		// "keep N most recent" expectation an operator gets from logrotate.
		// Pre-create three rotated files with stamped mtimes, then trigger
		// one more rotate — verify the oldest pre-existing one is unlinked.
		\file_put_contents( "{$this->tmp}/out.log-old1", 'old1' );
		\touch( "{$this->tmp}/out.log-old1", 1000 );
		\file_put_contents( "{$this->tmp}/out.log-old2", 'old2' );
		\touch( "{$this->tmp}/out.log-old2", 2000 );
		\file_put_contents( "{$this->tmp}/out.log-old3", 'old3' );
		\touch( "{$this->tmp}/out.log-old3", 3000 );

		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log append 0 2" );
		$log->rotate();
		$log->remove_node();

		// 3 pre-existing + 1 just-rotated = 4 candidates. max=2 → 2 unlinked.
		// The two oldest (mtime=1000 and mtime=2000) should be gone; the
		// most recent rotated file (current rotate() call) and old3 (mtime
		// 3000) should remain.
		$this->assertFileDoesNotExist( "{$this->tmp}/out.log-old1" );
		$this->assertFileDoesNotExist( "{$this->tmp}/out.log-old2" );
		$this->assertFileExists( "{$this->tmp}/out.log-old3" );

		// Survivors span both schemes: the recent legacy file + the new .0.
		$this->assertFileExists( "{$this->tmp}/out.log.0" );
		$this->assertCount(
			2,
			\array_merge( \glob( "{$this->tmp}/out.log-*" ), \glob( "{$this->tmp}/out.log.[0-9]*" ) )
		);
	}

	public function test_max_rotations_zero_keeps_all_rotated_files(): void {
		// Default / 0 = unlimited (matches Tachikoma's behavior — leave
		// cleanup to the operator).
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log append 0 0" );
		$log->rotate();
		$log->rotate();
		$log->rotate();
		$log->remove_node();

		$this->assertCount( 3, \glob( "{$this->tmp}/out.log.[0-9]*" ) );
	}

	public function test_max_rotations_below_threshold_keeps_all(): void {
		// 3 pre-existing + 1 rotate = 4 candidates; max=10 means no prune.
		\file_put_contents( "{$this->tmp}/out.log-a", 'a' );
		\file_put_contents( "{$this->tmp}/out.log-b", 'b' );
		\file_put_contents( "{$this->tmp}/out.log-c", 'c' );

		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log append 0 10" );
		$log->rotate();
		$log->remove_node();

		// 3 legacy ({filename}-*) + the new .0; all kept (max=10).
		$this->assertCount(
			4,
			\array_merge( \glob( "{$this->tmp}/out.log-*" ), \glob( "{$this->tmp}/out.log.[0-9]*" ) )
		);
	}

	public function test_max_size_zero_disables_auto_rotation(): void {
		// Zero / unset max_size means "never auto-rotate" — operator must
		// drive rotation explicitly via TM_REQUEST.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log append 0" );
		$xs  = $this->bytestream( \str_repeat( 'x', 1000 ) );
		$ys  = $this->bytestream( \str_repeat( 'y', 1000 ) );
		$log->fill( $xs );
		$log->fill( $ys );
		$log->remove_node();

		// Single file accumulates all bytes; no rotated sibling.
		$this->assertSame( 2000, \strlen( \file_get_contents( "{$this->tmp}/out.log" ) ) );
		$this->assertCount( 0, \glob( "{$this->tmp}/out.log.[0-9]*" ) );
	}

	public function test_TM_REQUEST_rotate_renames_current_file_and_reopens(): void {
		// `rotate` is the operator-driven rotation hook (typically scheduled
		// nightly via a Scheduler node). Renames the current file and opens
		// a fresh one with the same path. Subsequent writes land in the new
		// file; the old file keeps its bytes intact under the new name.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$one = $this->bytestream( "before-rotate\n" );
		$log->fill( $one );

		$req                  = Message::new_message();
		$req[ Message::TYPE ] = Message::TM_REQUEST;
		$req[ Message::VALUE ] = 'rotate';
		$log->fill( $req );

		$two = $this->bytestream( "after-rotate\n" );
		$log->fill( $two );
		$log->remove_node();

		// Fresh file has only post-rotate bytes.
		$this->assertSame( "after-rotate\n", \file_get_contents( "{$this->tmp}/out.log" ) );

		// Pre-rotate bytes preserved in the .0 rotation.
		$this->assertSame( "before-rotate\n", \file_get_contents( "{$this->tmp}/out.log.0" ) );
	}

	public function test_TM_ERROR_is_dropped(): void {
		// Error messages are control plane, not data — must not pollute the
		// log file with caller-side error text. Mirrors Tachikoma Log.pm:69.
		$log                 = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log" );
		$msg                 = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_ERROR;
		$msg[ Message::VALUE ] = 'this should NOT land in the log';
		$log->fill( $msg );
		$log->remove_node();

		// File exists (constructor opened it) but is empty.
		$this->assertSame( '', \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_make_node_through_REPL_works_with_only_filename(): void {
		// `make Log mylog /path` (no mode, no max_size) — both trailing
		// ctor args fall through to defaults via cmd_make_node's variadic
		// spread. Pin the contract end-to-end through the same dispatch
		// path the shell uses.
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make', "Log mylog {$this->tmp}/out.log" );
		$node = \Newspack_Nodes\Core::node( 'mylog' );
		$this->assertInstanceOf( Log_Node::class, $node );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = "default-mode\n";
		$node->fill( $msg );
		$node->remove_node();

		$this->assertSame( "default-mode\n", \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_make_node_through_REPL_works_with_filename_and_mode(): void {
		// `make Log mylog /path overwrite` — max_size omitted, defaults to 0.
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make', "Log mylog {$this->tmp}/out.log overwrite" );

		// Pre-existing file content should be wiped by overwrite mode.
		\file_put_contents( "{$this->tmp}/out.log", "PRE-EXISTING\n" );

		// Re-create through the REPL after seeding (overwrite mode opens 'wb').
		$interpreter->dispatch( 'remove', 'mylog' );
		$interpreter->dispatch( 'make', "Log mylog {$this->tmp}/out.log overwrite" );

		$node = \Newspack_Nodes\Core::node( 'mylog' );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = "fresh\n";
		$node->fill( $msg );
		$node->remove_node();

		$this->assertSame( "fresh\n", \file_get_contents( "{$this->tmp}/out.log" ) );
	}

	public function test_make_node_through_REPL_coerces_max_size_string_to_int(): void {
		// Shell tokens are always strings; without strict_types the int
		// parameter accepts the coerced value. Verify max_size works
		// end-to-end through cmd_make_node.
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make', "Log mylog {$this->tmp}/out.log append 10" );

		$node = \Newspack_Nodes\Core::node( 'mylog' );
		// 11 bytes — auto-rotate fires post-write because 11 > 10.
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = "0123456789\n";
		$node->fill( $msg );
		$node->remove_node();

		// Rotated sibling exists → max_size took effect.
		$this->assertCount( 1, \glob( "{$this->tmp}/out.log.[0-9]*" ) );
	}

	public function test_dump_config_round_trips_ctor_args(): void {
		// Same convention as Partition/Topic/Consumer/Tail: $arguments is set
		// in the constructor so Node::dump_config emits a `make_node Log
		// <name> <filename> <mode> <max_size>` line that re-creates this
		// instance verbatim.
		$log = new Log_Node();
		$log->arguments( "{$this->tmp}/out.log overwrite 4096" );
		$log->name( 'mylog' );

		$out = $log->dump_config();
		$this->assertStringContainsString( 'make_node Log mylog', $out );
		$this->assertStringContainsString( "{$this->tmp}/out.log", $out );
		$this->assertStringContainsString( 'overwrite', $out );
		$this->assertStringContainsString( '4096', $out );
	}

	public function test_node_schema_categorizes_rotate_as_request_not_verb(): void {
		// `rotate` is handled by Log::fill()'s TM_REQUEST branch — i.e. a request
		// the node serves directly, NOT a command verb on a `{name}:config`
		// sibling interpreter (Log has none). The Inspector routes verbs to `{node}:config`
		// (→ NOT_AVAILABLE for Log) but routes requests to the node itself, which
		// is how rotate actually works. So rotate must live under 'requests'.
		$schema = Log_Node::node_schema();

		$request_names = \array_column( $schema['requests'] ?? [], 'name' );
		$this->assertContains( 'rotate', $request_names );

		$verb_names = \array_column( $schema['commands'] ?? [], 'name' );
		$this->assertNotContains( 'rotate', $verb_names );
		$this->assertSame( [], $schema['commands'] );
	}

	/**
	 * An unwritable path (parent is a regular file, so mkdir+fopen both fail)
	 * must leave $fh as null — not false. The property is typed resource|null;
	 * the fill() guard relies on is_resource(), but the stored value itself
	 * must honor the resource|null contract. fill()/rotate() must not fatal.
	 */
	public function test_unwritable_path_leaves_fh_null_not_false(): void {
		// A regular file standing in for the parent directory: mkdir() of the
		// "directory" fails, and fopen( "{file}/out.log" ) returns false.
		$blocker = "{$this->tmp}/blocker";
		\file_put_contents( $blocker, 'x' );
		$path = "{$blocker}/out.log";

		// The intentionally-failing fopen() emits an expected E_WARNING; swallow
		// it locally so the assertion (not the warning) is what the test reports.
		\set_error_handler( static fn (): bool => true, \E_WARNING );
		try {
			$log = new Log_Node();
			$log->arguments( $path );

			$ref = new \ReflectionClass( $log );
			$fh  = $ref->getProperty( 'fh' )->getValue( $log );
			$this->assertNull( $fh, 'failed open must store null (resource|null), never false' );

			// fill() and rotate() must degrade gracefully, not fatal, on a null handle.
			$msg = $this->bytestream( "y\n" );
			$log->fill( $msg );
			$log->rotate();
			$fh_after = $ref->getProperty( 'fh' )->getValue( $log );
			$this->assertNull( $fh_after, 'rotate() reopen of an unwritable path must also store null, never false' );
		} finally {
			\restore_error_handler();
		}
	}

	public function test_fill_counts_and_announces_a_failed_write(): void {
		// A full disk (/dev/full reports ENOSPC on every write) must NOT make
		// the log line vanish silently: the node records a write_failures count
		// and emits one loud, rate-limited line. This is the [22] "fail loud"
		// contract — a swallowed fwrite() is a data-loss bug with no signal.
		$log = new Log_Node();
		$log->arguments( '/dev/full' );

		$warned = '';
		\Newspack_Nodes\Core::set_stderr_handler( static function ( $msg ) use ( &$warned ) {
			$warned .= $msg;
		} );

		$msg = $this->bytestream( "cannot land\n" );
		$log->fill( $msg );
		$log->remove_node();

		$this->assertSame( 1, $log->write_failures(), 'a failed write must be counted, not swallowed' );
		$this->assertStringContainsString( 'write stalled', $warned );
	}

	private function bytestream( string $value ): array {
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = $value;
		return $msg;
	}
}

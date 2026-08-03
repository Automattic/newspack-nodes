<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Log_Sources;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Timer_Node;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Interpreter_Node::class )]
class CommandInterpreterTest extends TestCase {
	protected function tearDown(): void {
		// $default_authorize is static process state — reset so tests don't bleed.
		Command_Interpreter_Node::$default_authorize = null;
		Log_Sources::$builtin_sources                = null;
		Router_Node::profiles( null );
		parent::tearDown();
	}

	/** Build a TM_COMMAND Message (empty TO) for the interpret path. */
	private function command_message( string $name, string $args = '', bool $local = false ): array {
		$m                    = Message::new_message();
		$m[ Message::TYPE ]   = Message::TM_COMMAND;
		$m[ Message::FROM ]   = '_output/1';
		$m[ Message::VALUE ]  = [ 'name' => $name, 'arguments' => '' === $args ? [] : \preg_split( '/\s+/', $args ) ];
		if ( $local ) {
			$m[ Message::LOCAL ] = true;
		}
		return $m;
	}

	public function test_reply_to_runs_the_verb_locally_and_routes_its_reply_to_the_path(): void {
		// reply_to <path> <verb> [<args>]: run <verb> HERE, but route its reply to
		// <path> (the inverse of command_node, which runs it AT <path>). This is the
		// primitive that lets a worker drive a remote interpreter's output to one session,
		// e.g. `cmd _repl reply_to _http/_sse:411/_output ls -als`.
		$interpreter   = new Command_Interpreter_Node();
		$sink = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$message = $this->command_message( 'reply_to', 'some/target uptime', true );
		$interpreter->fill( $message );
		// reply_to itself replies with nothing; the sub-verb's reply rode to <path>.
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'some/target', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'uptime', $sink->captured[0][ Message::VALUE ]['name'] );
	}

	public function test_reply_to_without_a_command_returns_usage(): void {
		$interpreter   = new Command_Interpreter_Node();
		$sink = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$message = $this->command_message( 'reply_to', 'some/target', true );
		$interpreter->fill( $message );
		$this->assertCount( 1, $sink->captured );
		$this->assertStringContainsString(
			'usage: reply_to',
			(string) $sink->captured[0][ Message::VALUE ]['payload']
		);
	}

	public function test_reply_to_refuses_to_nest(): void {
		// Nesting reply_to would recurse synchronously (interpret → cmd_reply_to →
		// fill → interpret …) with no FROM growth to bound it; refuse it. The test
		// completing at all proves there's no unbounded recursion.
		$interpreter   = new Command_Interpreter_Node();
		$sink = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$message = $this->command_message( 'reply_to', 'a reply_to a uptime', true );
		$interpreter->fill( $message );
		$this->assertCount( 1, $sink->captured );
		$this->assertStringContainsString(
			'reply_to cannot invoke reply_to',
			(string) $sink->captured[0][ Message::VALUE ]['payload']
		);
	}

	public function test_noreply_command_runs_but_emits_no_response(): void {
		// A TM_NOREPLY command's verb still runs, but its (successful) reply is
		// suppressed — a topology loaded with no console to reply to mustn't bounce
		// a response off the absent `_output`.
		$interpreter = new Command_Interpreter_Node();
		$sink        = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$message                  = $this->command_message( 'uptime', '', true );
		$message[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_NOREPLY;
		$interpreter->fill( $message );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_noreply_command_error_is_logged_to_stderr_not_replied(): void {
		// Tachikoma CommandInterpreter::send_response: a failing TM_NOREPLY command
		// still surfaces its error via stderr (so a bad boot make_node is visible in
		// dmesg) — but emits no routed response.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$interpreter = new Command_Interpreter_Node();
		$sink        = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$message                  = $this->command_message( 'no_such_verb', '', true );
		$message[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_NOREPLY;
		$interpreter->fill( $message );
		$this->assertCount( 0, $sink->captured );
		$this->assertStringContainsString( 'error from TM_NOREPLY command', $buf );
		$this->assertStringContainsString( 'no_such_verb', $buf );
	}

	public function test_worker_should_stop_from_a_verb_propagates(): void {
		// Cooperative-stop is control flow, not a verb error: a verb raising
		// Worker_Should_Stop must propagate so the worker stops, not be wrapped
		// into a TM_ERROR response (ADR-14).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );
		$interpreter->commands(
			[
				'stopme' => function (): void {
					throw new Worker_Should_Stop( 'cooperative stop' );
				},
			]
		);

		$this->expectException( Worker_Should_Stop::class );
		$interpreter->fill( $this->command_message( 'stopme', '', true ) );
	}

	public function test_list_timers_lists_registered_timers(): void {
		Event_Framework::reset();
		$router = new \Newspack_Nodes\Router_Node(); // real _router declares the TIMER event
		$router->name( '_router' );
		$timer = new Timer_Node();
		$timer->name( 'tick0' );
		$timer->set_timer( 250 ); // own-slot: NEXT is ms-to-fire
		$hitch = new Timer_Node();
		$hitch->name( 'hitch0' );
		$hitch->set_timer( 15000 ); // >= 1000 -> router-hitchhike: NEXT is _router
		$trans = new Timer_Node();
		$trans->name( 'trans0' );
		$trans->set_timer( 300 );   // own-slot seeds next_fire > 0 ...
		$trans->set_timer( 20000 ); // ... then re-arm as router: stale next_fire must clear
		$idle = new Timer_Node(); // never armed -> inactive
		$idle->name( 'idle0' );

		$out = ( new Command_Interpreter_Node() )->dispatch( 'list_timers' );

		$this->assertStringContainsString( 'ACTIVE', $out, 'has an ACTIVE column' );
		$this->assertStringContainsString( 'MODE', $out, 'has a MODE column (matches the JS console table)' );
		$this->assertStringContainsString( 'FIRES', $out, 'has a FIRES (fire count) column' );
		$this->assertStringContainsString( '250', $out, 'shows the interval_ms' );
		$row_of = static function ( string $name ) use ( $out ): string {
			foreach ( \explode( "\n", $out ) as $line ) {
				if ( \str_contains( $line, $name ) ) {
					return $line;
				}
			}
			return '';
		};
		$this->assertStringContainsString( 'event_framework', $row_of( 'tick0' ), 'own-slot timer reads MODE=event_framework' );
		$this->assertStringContainsString( 'router', $row_of( 'hitch0' ), 'a hitchhiking timer reads MODE=router' );
		$this->assertStringContainsString( '-', $row_of( 'hitch0' ), 'a hitchhiker has no own next_fire; NEXT is -' );
		$this->assertStringContainsString( 'router', $row_of( 'trans0' ), 'own-slot -> router re-arm reads MODE=router (stale next_fire cleared)' );
		$this->assertStringContainsString( 'inactive', $row_of( 'idle0' ), 'the never-armed timer reads MODE=inactive' );
		$this->assertStringContainsString( 'no', $row_of( 'idle0' ), 'the never-armed timer reads ACTIVE=no' );
	}

	public function test_list_handles_lists_registered_curl_handles(): void {
		Event_Framework::reset();
		$node = new Echo_Node();
		$node->name( 'sse0' );
		$easy = \curl_init();
		Event_Framework::instance()->register_curl_easy( $node, $easy );

		$out = ( new Command_Interpreter_Node() )->dispatch( 'list_handles' );

		$this->assertStringContainsString( 'sse0', $out, 'names the node holding a curl handle' );
		$this->assertStringContainsString( 'COUNT', $out, 'has a COUNT (messages processed) column' );
	}

	public function test_list_timers_and_list_handles_dash_s_return_keyed_rows(): void {
		Event_Framework::reset();
		$router = new \Newspack_Nodes\Router_Node(); // real _router declares the TIMER event
		$router->name( '_router' );
		$timer = new Timer_Node();
		$timer->name( 'tick0' );
		$timer->set_timer( 250 ); // own-slot: distinct interval, active, numeric next_ms
		$hitch = new Timer_Node();
		$hitch->name( 'hitch0' );
		$hitch->set_timer( 15000 ); // hitchhike: no own next_fire -> next_ms null

		$sse = new Echo_Node();
		$sse->name( 'sse0' );
		$easy = \curl_init();
		Event_Framework::instance()->register_curl_easy( $sse, $easy );

		$ci      = new Command_Interpreter_Node();
		$timers  = $ci->dispatch( 'list_timers', [ '-s' ] );
		$handles = $ci->dispatch( 'list_handles', [ '-s' ] );

		$this->assertIsArray( $timers );
		$this->assertIsArray( $handles );

		$by_name = [];
		foreach ( $timers as $row ) {
			$by_name[ $row['name'] ] = $row;
		}
		$this->assertSame(
			[ 'id', 'active', 'interval_ms', 'mode', 'next_ms', 'oneshot', 'fires', 'type', 'name' ],
			\array_keys( $by_name['tick0'] ),
			'timer rows are keyed, not positional'
		);
		$this->assertTrue( $by_name['tick0']['active'] );
		$this->assertSame( 250, $by_name['tick0']['interval_ms'] );
		$this->assertSame( 'event_framework', $by_name['tick0']['mode'] );
		$this->assertIsInt( $by_name['tick0']['next_ms'], 'own-slot timer carries a numeric next_ms' );
		$this->assertLessThanOrEqual( 250, $by_name['tick0']['next_ms'] );
		$this->assertFalse( $by_name['tick0']['oneshot'] );
		$this->assertSame( 'Timer_Node', $by_name['tick0']['type'] );
		$this->assertNull( $by_name['hitch0']['next_ms'], 'a hitchhiker has no own next_fire; next_ms is null' );

		$this->assertCount( 1, $handles );
		$handle = $handles[0];
		$this->assertSame( [ 'id', 'count', 'type', 'name' ], \array_keys( $handle ), 'handle rows are keyed, not positional' );
		$this->assertSame( 'sse0', $handle['name'] );
		Event_Framework::instance()->unregister_curl_easy( $easy );
	}

	public function test_list_profiles_dash_s_returns_every_column_the_table_prints(): void {
		// Seed the Router self-time table directly (values distinct from the
		// disabled-null default) — `-s` reads it verbatim.
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
		Router_Node::profiles(
			[
				'alice' => [ 'time' => 0.30, 'count' => 3, 'avg' => 0.10, 'oldest' => 100.0, 'timestamp' => 130.0 ],
				'bob'   => [ 'time' => 0.10, 'count' => 5, 'avg' => 0.02, 'oldest' => 100.0, 'timestamp' => 130.0 ],
			]
		);

		$rows = ( new Command_Interpreter_Node() )->dispatch( 'list_profiles', [ '-s' ] );

		$this->assertIsArray( $rows );
		$by_name = \array_column( $rows, null, 'what' );
		$this->assertSame(
			[ 'avg', 'time', 'count', 'window', 'rate', 'age', 'what' ],
			\array_keys( $by_name['alice'] ),
			'-s carries every column the text table prints'
		);
		$this->assertEqualsWithDelta( 0.10, $by_name['alice']['avg'], 1e-9 );
		$this->assertEqualsWithDelta( 0.30, $by_name['alice']['time'], 1e-9 );
		$this->assertSame( 3, $by_name['alice']['count'] );
		// window = timestamp - oldest = 30, distinct from avg/time/count.
		$this->assertEqualsWithDelta( 30.0, $by_name['alice']['window'], 1e-9 );
		$this->assertEqualsWithDelta( 0.02, $by_name['bob']['avg'], 1e-9 );

		// Total rides in as a row: summed time/count, avg = 0.40 / 8.
		$total = $by_name['--total--'];
		$this->assertEqualsWithDelta( 0.40, $total['time'], 1e-9 );
		$this->assertSame( 8, $total['count'] );
		$this->assertEqualsWithDelta( 0.05, $total['avg'], 1e-9 );
	}

	/** Write $lines (each padded to $width chars) as fixed-width $width+1-byte rows to a fresh temp file. */
	private function write_fixed_width_log( int $count, int $width ): string {
		$path  = \tempnam( \sys_get_temp_dir(), 'taillog' );
		$lines = [];
		for ( $i = 0; $i < $count; $i++ ) {
			$lines[] = \str_pad( \sprintf( 'evlog-line-%04d', $i ), $width, '.' );
		}
		\file_put_contents( $path, \implode( "\n", $lines ) . "\n" );
		return $path;
	}

	public function test_taillog_tails_the_last_bytes_and_drops_the_partial_first_line(): void {
		// 40 rows x 60 bytes = 2400 bytes; a 1KB tail lands mid-row 22, so the
		// first WHOLE row is 0023 — a value distinct from the 16KB default window.
		$path = $this->write_fixed_width_log( 40, 59 );

		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$out = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'php', '1' ] );

		$this->assertStringStartsWith( 'evlog-line-0023', $out, 'the partial first row is dropped; output opens on the first WHOLE row' );
		$this->assertStringNotContainsString( 'evlog-line-0000', $out, 'rows before the byte window are cut' );
		$this->assertStringContainsString( 'evlog-line-0039', $out, 'the newest row is present' );

		\unlink( $path );
	}

	public function test_taillog_returns_the_whole_file_when_smaller_than_the_window(): void {
		// A file under the 16KB default window returns entire, first row intact.
		$path = $this->write_fixed_width_log( 5, 59 );

		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		$out = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'php' ] );

		$this->assertStringContainsString( 'evlog-line-0000', $out, 'no partial-line drop when the window starts at byte 0' );
		$this->assertStringContainsString( 'evlog-line-0004', $out );

		\unlink( $path );
	}

	public function test_taillog_with_no_source_lists_the_registry_with_availability(): void {
		$present = $this->write_fixed_width_log( 3, 59 );
		$missing = (string) \realpath( \sys_get_temp_dir() ) . '/taillog-does-not-exist-9271';

		Log_Sources::$builtin_sources = static fn (): array => [
			'php'   => $present,
			'debug' => $missing,
		];

		$out = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [] );

		$this->assertStringContainsString( 'SOURCE', $out, 'lists a SOURCE column' );
		$this->assertStringContainsString( 'AVAILABLE', $out, 'lists an AVAILABLE column' );
		$this->assertStringContainsString( $present, $out, 'names the resolved php path' );
		$this->assertStringContainsString( $missing, $out, 'names the resolved debug path even though it is absent' );
		$this->assertStringContainsString( '180', $out, 'reports the byte size of the present file (3 rows x 60 bytes)' );

		\unlink( $present );
	}

	public function test_taillog_missing_file_returns_a_teaching_error_naming_the_path(): void {
		$missing = (string) \realpath( \sys_get_temp_dir() ) . '/taillog-absent-4418.log';

		Log_Sources::$builtin_sources = static fn (): array => [ 'debug' => $missing ];

		$out = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'debug' ] );

		$this->assertStringContainsString( $missing, $out, 'the error names the resolved path (errors-as-docs)' );
	}

	public function test_taillog_rejects_an_unknown_source_name_never_a_path(): void {
		$path = $this->write_fixed_width_log( 3, 59 );

		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $path ];

		// A caller-supplied path is NOT a registry name: no traversal.
		$out = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ '../../../../etc/passwd' ] );

		$this->assertStringContainsString( 'unknown log source', $out );
		$this->assertStringNotContainsString( 'root:', $out, 'never reads a caller-supplied path' );

		\unlink( $path );
	}

	public function test_taillog_sources_returns_a_struct_of_name_path_available_rows(): void {
		$present = $this->write_fixed_width_log( 3, 59 );
		$missing = (string) \realpath( \sys_get_temp_dir() ) . '/taillog-sources-absent-5573.log';

		Log_Sources::$builtin_sources = static fn (): array => [
			'php'   => $present,
			'debug' => $missing,
		];

		$rows = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'sources' ] );

		$this->assertSame(
			[
				[
					'name'      => 'php',
					'path'      => $present,
					'mode'      => 'file',
					'available' => true,
					// The file's current byte size — the Log Viewer's replay boundary.
					'bytes'     => \filesize( $present ),
					'segments'  => [],
				],
				[
					'name'      => 'debug',
					'path'      => $missing,
					'mode'      => 'file',
					'available' => false,
					// An unavailable source has no readable size.
					'bytes'     => null,
					'segments'  => [],
				],
			],
			$rows,
			'the reserved `sources` name returns an array a GUI reads to build its picker'
		);

		\unlink( $present );
	}

	public function test_taillog_sources_reflects_the_full_merged_registry(): void {
		// The struct is the Log Viewer's catalog: a config `log_sources` entry
		// must appear beside the built-ins, each row carrying its Tail mode.
		$present = $this->write_fixed_width_log( 3, 59 );
		Log_Sources::$builtin_sources = static fn (): array => [ 'php' => $present ];
		$this->use_base_dir(
			$this->make_temp_dir( 'ci-taillog-merge-' ),
			[ 'log_sources' => [ 'gyro=/var/log/gyro-6203.log' ] ]
		);

		$rows = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'sources' ] );

		$this->assertIsArray( $rows );
		$this->assertSame( [ 'php', 'gyro' ], \array_column( $rows, 'name' ) );
		$this->assertSame( [ 'file', 'file' ], \array_column( $rows, 'mode' ) );

		\unlink( $present );
	}

	public function test_taillog_tails_the_newest_segment_of_a_segmented_source(): void {
		// A topology Log source is segmented ({file}.{seg}); `sources` reports
		// it available, so `taillog <name>` must tail its NEWEST segment — never
		// "log unavailable" on the bare base path the segments hang off.
		Log_Sources::$builtin_sources = static fn (): array => [];
		$tmp = $this->make_temp_dir( 'ci-taillog-seg-' );
		\mkdir( "{$tmp}/topologies", 0755, true );
		\file_put_contents(
			"{$tmp}/topologies/seg-src.tsl",
			"make_node Log gate:log <config:logs_dir>/gate-events.jsonl 1 2 7\n"
		);
		try {
			\Newspack_Nodes\Topology_Registry::register_stock_dir( "{$tmp}/topologies" );
			$this->use_base_dir( $tmp, [ 'topologies' => [ 'seg-src' ] ] );
			\mkdir( "{$tmp}/logs", 0755, true );
			\file_put_contents( "{$tmp}/logs/gate-events.jsonl.0", "old-row-0001\n" );
			\file_put_contents( "{$tmp}/logs/gate-events.jsonl.1", \str_pad( 'new-row-7345', 976, '.' ) . "\n" );

			$out = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'gate-events.jsonl' ] );
			$this->assertStringContainsString( 'new-row-7345', $out, 'tails the newest segment' );
			$this->assertStringNotContainsString( 'old-row-0001', $out, 'older segments are not the tail' );

			$list = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [] );
			$this->assertStringContainsString( '977', $list, 'BYTES reports the newest segment size, not "-"' );
		} finally {
			\Newspack_Nodes\Topology_Registry::reset();
		}
	}

	public function test_taillog_sources_dedupes_two_names_resolving_to_the_same_real_file(): void {
		// On this host php `error_log` IS wp-content/debug.log: two DISTINCT path
		// strings (a symlink) pointing at ONE real file must collapse to one row,
		// keeping `php` (the ini-configured aggregation point).
		$real = $this->write_fixed_width_log( 3, 59 );
		$link = $real . '.alias';
		\symlink( $real, $link );

		Log_Sources::$builtin_sources = static fn (): array => [
			'php'   => $real,
			'debug' => $link,
		];

		$rows = ( new Command_Interpreter_Node() )->dispatch( 'taillog', [ 'sources' ] );

		$this->assertIsArray( $rows );
		$this->assertSame( [ 'php' ], \array_column( $rows, 'name' ), 'the duplicate `debug` alias of the same real file is dropped' );

		\unlink( $link );
		\unlink( $real );
	}

	public function test_tabulate_is_public_and_column_aligns_rows(): void {
		// Promoted private → public static so Log_Sources / Node_Schema_Help /
		// Service_CI subclasses share the ONE renderer. Two rows whose left cell
		// widths differ force real padding (distinct from a no-op single-width).
		$out = Command_Interpreter_Node::tabulate(
			[ 'left', 'left' ],
			[ 'NAME', 'VALUE' ],
			[
				[ 'x', 'short' ],
				[ 'longer-name', 'v' ],
			]
		);

		$this->assertSame(
			"NAME        VALUE\nx           short\nlonger-name v\n",
			$out
		);
	}

	public function test_interpret_refuses_command_without_local_provenance(): void {
		$interpreter   = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$sink = new Capture_Sink_Node();
		$interpreter->sink( $sink );

		$message = $this->command_message( 'make_node', 'Capture_Sink ghost' ); // no LOCAL
		$interpreter->fill( $message );

		// Verb did NOT run — node never created.
		$this->assertNull( Core::node( 'ghost' ) );
		// An unauthorized error response was emitted.
		$resp = $sink->captured[0] ?? null;
		$this->assertNotNull( $resp );
		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $resp[ Message::TYPE ] );
		$this->assertStringContainsString( 'unauthorized', $resp[ Message::VALUE ]['payload'] );
	}

	public function test_authorize_that_logged_a_reason_squelches_the_redundant_unauthorized(): void {
		// When authorize (e.g. HMAC verify) already logged a SPECIFIC reason via
		// drop_message, the interpreter must NOT also log the generic "unauthorized"
		// — but it still returns the unauthorized error response to the client.
		$interpreter = new class() extends Command_Interpreter_Node {
			/** @var string[] */
			public array $dropped = [];
			public function drop_message( array $message, string $error ): void {
				$this->dropped[] = $error;
				parent::drop_message( $message, $error );
			}
		};
		$interpreter->name( '_command_interpreter' );
		$sink = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$interpreter->authorize = function ( Command_Interpreter_Node $ci, array $m ): bool {
			$ci->drop_message( $m, 'verification failed: timestamp out of range' );
			return false;
		};

		$interpreter->fill( $this->command_message( 'dump_metadata' ) );

		$this->assertSame(
			[ 'verification failed: timestamp out of range' ],
			$interpreter->dropped,
			'only the specific reason is logged; the redundant unauthorized is squelched'
		);
		$resp = $sink->captured[0] ?? null;
		$this->assertNotNull( $resp, 'the unauthorized error response is still sent' );
		$this->assertStringContainsString( 'unauthorized', $resp[ Message::VALUE ]['payload'] );
	}

	public function test_bare_authorize_rejection_is_quiet(): void {
		$interpreter = new class() extends Command_Interpreter_Node {
			/** @var string[] */
			public array $dropped = [];
			public function drop_message( array $message, string $error ): void {
				$this->dropped[] = $error;
				parent::drop_message( $message, $error );
			}
		};
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );
		$interpreter->authorize = static fn ( Command_Interpreter_Node $ci, array $m ): bool => false;

		$interpreter->fill( $this->command_message( 'dump_metadata' ) );

		$this->assertSame( [], $interpreter->dropped );
	}

	public function test_interpret_allows_command_with_local_provenance(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		$message = $this->command_message( 'make_node', 'Capture_Sink real', true ); // LOCAL
		$interpreter->fill( $message );

		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'real' ) );
	}

	public function test_instance_authorize_overrides_default_local_check(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );
		$interpreter->authorize = static fn ( Command_Interpreter_Node $ci, array $m ): bool => true;

		$message = $this->command_message( 'make_node', 'Capture_Sink trusted' ); // no LOCAL
		$interpreter->fill( $message );

		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'trusted' ) );
	}

	public function test_static_default_authorize_can_refuse_even_with_local(): void {
		Command_Interpreter_Node::$default_authorize = static fn ( Command_Interpreter_Node $ci, array $m ): bool => false;
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		$message = $this->command_message( 'make_node', 'Capture_Sink nope', true ); // LOCAL set
		$interpreter->fill( $message );
		$this->assertNull( Core::node( 'nope' ) );

		// Instance override beats the static default.
		$interpreter->authorize = static fn ( Command_Interpreter_Node $ci, array $m ): bool => true;
		$message2 = $this->command_message( 'make_node', 'Capture_Sink yes' );
		$interpreter->fill( $message2 );
		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'yes' ) );
	}

	public function test_dispatch_is_not_gated_for_programmatic_callers(): void {
		// The gate lives in interpret() (message path); direct dispatch() stays open
		// for topology/setup code.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'direct' ] );
		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'direct' ) );
	}

	public function test_make_node_creates_named_node_in_registry(): void {
		// Capture_Sink_Node resolves via the `Newspack_Nodes\Tests\` prefix
		// registered in bootstrap, so `make_node Capture_Sink ...` works.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$node = Core::node( 'alice' );
		$this->assertNotNull( $node );
		$this->assertInstanceOf( Capture_Sink_Node::class, $node );
	}

	public function test_make_node_auto_sinks_new_node_into_command_interpreter(): void {

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$bob = Core::node( 'bob' );

		$this->assertSame( $interpreter, $bob->sink() );
	}

	public function test_make_node_unregisters_the_node_when_arguments_throws(): void {
		// name() registers before arguments() can reject; without the rollback a
		// failed make_node leaves a sink-less orphan in the graph that every
		// later `ls` shows and no message can leave. Table is a real class whose
		// arguments() throws (namespace is required).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$threw = false;
		try {
			$interpreter->make_node( 'Table', 'doomed' );
		} catch ( \InvalidArgumentException $e ) {
			$threw = true;
		}

		$this->assertTrue( $threw, 'make_node must propagate the arguments() failure' );
		$this->assertNull( Core::node( 'doomed' ), 'a failed make_node must leave no node registered' );
		// name() registers the sibling too, so the rollback has to take both —
		// a bare unregister would leave `doomed:config` squatting the name.
		$this->assertNull( Core::node( 'doomed:config' ), 'the :config sibling must go with it' );
	}

	public function test_tabulate_terminates_its_last_row(): void {
		// The write seam no longer appends, so each producer ends its own block
		// (Tachikoma: every verb is responsible for its trailing newline).
		$out = Command_Interpreter_Node::tabulate(
			[ 'l', 'l' ],
			[ 'NAME', 'SINK' ],
			[ [ 'alice', '_router' ] ]
		);

		$this->assertStringEndsWith( "\n", $out );
		$this->assertStringNotContainsString( "\n\n", $out );
	}

	public function test_make_node_returns_ok_string(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$result = $interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$this->assertSame( "ok\n", $result );
	}

	public function test_make_node_sets_arguments_from_trailing_tokens(): void {
		// arguments() is set IN make_node (from the trailing tokens), not
		// downstream in the node ctor — so every node, uniformly, round-trips
		// through dump_config.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice', 'some', 'args', 'here' ] );

		$this->assertSame( [ 'some', 'args', 'here' ], Core::node( 'alice' )->arguments() );
	}

	public function test_make_node_sets_empty_arguments_with_no_trailing_tokens(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$this->assertSame( [], Core::node( 'alice' )->arguments() );
	}

	public function test_make_node_resolves_the_base_Node_class(): void {
		// The base Node has no `_Node` suffix, so `make_node Node` resolves it
		// directly (under any registered namespace). Its default fill() stamps
		// TO=target and forwards to sink — a bare routing/fan-in primitive (e.g.
		// the SSE-stream process's `_default_route`).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$result = $interpreter->dispatch( 'make_node', [ 'Node', 'router' ] );

		$this->assertSame( "ok\n", $result );
		$node = Core::node( 'router' );
		$this->assertNotNull( $node );
		$this->assertSame( Node::class, \get_class( $node ) );
		$this->assertSame( $interpreter, $node->sink() );
	}

	public function test_make_node_Node_round_trips_through_shell_name(): void {
		// dump_config emits `make_node <shell_name> <name>`; the base Node's shell
		// name is `Node` (no `_Node` suffix to strip), so the emitted line feeds
		// straight back into make_node.
		$node = new Node();
		$this->assertSame(
			'Node',
			Command_Interpreter_Node::shell_name_for( $node )
		);
	}

	public function test_thrown_error_message_is_html_decoded_in_the_reply_payload(): void {
		// Verb handlers esc_html() their dynamic throw messages to satisfy the
		// phpcs EscapeOutput sniff, but the TM_ERROR payload is plain text for a
		// JSON/terminal sink (React + the cli both re-escape / print raw). interpret()
		// must decode so the UI shows `'`/`<`/`>`, not `&#039;`/`&lt;`/`&gt;`.
		$interpreter = new Command_Interpreter_Node();
		$sink        = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$interpreter->commands(
			[
				'boom' => static function (): string {
					throw new \RuntimeException(
						"activating &#039;perf&#039; conflicts: a &lt;b&gt;"
					);
				},
			]
		);

		$message = $this->command_message( 'boom', '', true );
		$interpreter->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$reply = $sink->captured[0];
		$this->assertSame(
			Message::TM_COMMAND | Message::TM_ERROR,
			$reply[ Message::TYPE ]
		);
		$this->assertSame(
			"activating 'perf' conflicts: a <b>\n",
			$reply[ Message::VALUE ]['payload']
		);
	}

	public function test_dispatch_throws_on_unknown_command(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown command: nope' );
		$interpreter->dispatch( 'nope' );
	}

	public function test_old_debug_state_verb_name_no_longer_resolves(): void {
		// The verb renamed to `trace`; the reply strings still report the
		// unchanged `debug_state` node property, but the old verb is gone.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown command: debug_state' );
		$interpreter->dispatch( 'debug_state' );
	}

	public function test_debug_state_no_args_toggles_self(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->assertSame( 0, $interpreter->debug_state() );

		$this->assertSame( "_command_interpreter debug_state: 1\n", $interpreter->dispatch( 'trace' ) );
		$this->assertSame( 1, $interpreter->debug_state() );

		$this->assertSame( "_command_interpreter debug_state: 0\n", $interpreter->dispatch( 'trace' ) );
		$this->assertSame( 0, $interpreter->debug_state() );
	}

	public function test_debug_state_numeric_arg_sets_self_to_level(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertSame( "_command_interpreter debug_state: 2\n", $interpreter->dispatch( 'trace', [ '2' ] ) );
		$this->assertSame( 2, $interpreter->debug_state() );
	}

	public function test_debug_state_with_node_name_toggles_that_node(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$alice = Core::node( 'alice' );
		$this->assertSame( 0, $alice->debug_state() );

		$this->assertSame( "alice debug_state: 1\n", $interpreter->dispatch( 'trace', [ 'alice' ] ) );
		$this->assertSame( 1, $alice->debug_state() );

		$this->assertSame( "alice debug_state: 0\n", $interpreter->dispatch( 'trace', [ 'alice' ] ) );
		$this->assertSame( 0, $alice->debug_state() );
	}

	public function test_debug_state_star_sets_every_node_and_returns_a_terse_summary(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		// Level 2 (distinct from the toggle default 1) over 2 nodes: the
		// interpreter + alice. The reply is a one-liner, not a per-node roster.
		$out = $interpreter->dispatch( 'trace', [ '*', '2' ] );
		$this->assertSame( "debug_state 2 on 2 nodes\n", $out );
		$this->assertStringNotContainsString( 'alice debug_state', $out );
		$this->assertSame( 2, Core::node( 'alice' )->debug_state() );
		$this->assertSame( 2, $interpreter->debug_state() );
	}

	public function test_debug_state_with_node_name_and_level_sets_explicitly(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$this->assertSame( "alice debug_state: 3\n", $interpreter->dispatch( 'trace', [ 'alice', '3' ] ) );
		$this->assertSame( 3, Core::node( 'alice' )->debug_state() );
	}

	public function test_debug_state_unknown_node_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertSame( "unknown node: nonexistent\n", $interpreter->dispatch( 'trace', [ 'nonexistent' ] ) );
	}

	public function test_make_node_propagates_ci_debug_state_to_children(): void {
		// When the CommandInterpreter has debug_state set, every node it
		// creates via make_node inherits the same level. Lets the operator
		// turn on tracing for an entire topology in one command:
		//   trace 1
		//   make_node Foo bar
		//   make_node Foo baz  ← also at level 1
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'trace', [ '1' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$alice = Core::node( 'alice' );
		$this->assertSame( 1, $alice->debug_state(), 'new node inherits interpreter level' );
	}

	public function test_make_node_does_not_propagate_when_ci_state_is_zero(): void {
		// Inverse: nodes constructed while the interpreter is at default level 0
		// stay at level 0. No "inherit zero" pun intended — the test guards
		// against accidental writebacks if the propagation logic is sloppy.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$this->assertSame( 0, Core::node( 'alice' )->debug_state() );
	}

	public function test_command_interpreter_forwards_non_commands_to_sink(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
	}

	public function test_command_interpreter_executes_TM_COMMAND(): void {

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		// VALUE rides as a live PHP structure (no separate json_encode) —
		// it travels through packed()/unpacked() as a nested object.
		$message[ Message::VALUE ] = [
			'name'      => 'make_node',
			'arguments' => [ 'Capture_Sink', 'alice' ],
		];
		$message[ Message::LOCAL ] = true; // in-process command — carries the provenance taint
		$interpreter->fill( $message );

		$this->assertNotNull( Core::node( 'alice' ) );
	}

	public function test_set_sink_wires_one_node_to_another(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'set_sink', [ 'alice', 'bob' ] );

		$this->assertSame( Core::node( 'bob' ), Core::node( 'alice' )->sink() );
	}

	public function test_connect_node_sets_target(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'connect_node', [ 'alice', 'bob' ] );

		$this->assertSame( 'bob', Core::node( 'alice' )->target() );
	}

	public function test_disconnect_node_clears_target(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'connect_node', [ 'alice', 'bob' ] );
		$interpreter->dispatch( 'disconnect_node', [ 'alice' ] );

		$this->assertSame( '', Core::node( 'alice' )->target() );
	}

	/** Source node that pre-declares one event so `register` can attach a listener to it. */
	private function emitter_with_event( string $name, string $event ): Node {
		$node = new class( $event ) extends Node {
			public function __construct( string $event ) {
				$this->registrations = [ $event => [] ];
			}
		};
		$node->name( $name );
		return $node;
	}

	public function test_register_wires_a_node_name_listener_on_the_source(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$source = $this->emitter_with_event( 'source', 'EVT' );
		( new Echo_Node() )->name( 'target' );

		$this->assertSame( "ok\n", $interpreter->dispatch( 'register', [ 'source', 'target', 'EVT' ] ) );
		$this->assertSame( [ 'EVT' => [ 'target' ] ], $source->registered_listeners() );
	}

	public function test_register_unknown_source_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		( new Echo_Node() )->name( 'target' );

		$this->assertSame( "unknown node: source\n", $interpreter->dispatch( 'register', [ 'source', 'target', 'EVT' ] ) );
	}

	public function test_register_unknown_target_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->emitter_with_event( 'source', 'EVT' );

		$this->assertSame( "unknown node: target\n", $interpreter->dispatch( 'register', [ 'source', 'target', 'EVT' ] ) );
	}

	public function test_register_missing_args_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertSame( "usage: register <source name> <target name> <event>\n", $interpreter->dispatch( 'register' ) );
	}

	public function test_register_missing_target_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->emitter_with_event( 'source', 'EVT' );

		$this->assertSame( "usage: register <source name> <target name> <event>\n", $interpreter->dispatch( 'register', [ 'source' ] ) );
	}

	public function test_register_undeclared_event_surfaces_as_command_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->emitter_with_event( 'source', 'EVT' );
		( new Echo_Node() )->name( 'target' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no such event: NOPE' );
		$interpreter->dispatch( 'register', [ 'source', 'target', 'NOPE' ] );
	}

	public function test_unregister_removes_a_previously_registered_listener(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$source = $this->emitter_with_event( 'source', 'EVT' );
		( new Echo_Node() )->name( 'target' );

		$interpreter->dispatch( 'register', [ 'source', 'target', 'EVT' ] );
		$this->assertSame( "ok\n", $interpreter->dispatch( 'unregister', [ 'source', 'target', 'EVT' ] ) );
		$this->assertSame( [], $source->registered_listeners() );
	}

	public function test_unregister_missing_args_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertSame( "usage: unregister <source name> <target name> <event>\n", $interpreter->dispatch( 'unregister' ) );
	}

	public function test_remove_node_removes_single_node(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$this->assertNotNull( Core::node( 'alice' ) );

		$out = $interpreter->dispatch( 'remove_node', [ 'alice' ] );
		$this->assertStringContainsString( 'removed alice', $out );
		$this->assertNull( Core::node( 'alice' ) );
	}

	public function test_remove_node_aliases_remove_and_rm_match(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'remove', [ 'alice' ] );
		$this->assertNull( Core::node( 'alice' ) );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'rm', [ 'bob' ] );
		$this->assertNull( Core::node( 'bob' ) );
	}

	public function test_remove_node_accepts_multiple_names(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'carol' ] );

		$out = $interpreter->dispatch( 'remove_node', [ 'alice', 'bob', 'carol' ] );

		$this->assertStringContainsString( 'removed alice', $out );
		$this->assertStringContainsString( 'removed bob',   $out );
		$this->assertStringContainsString( 'removed carol', $out );
		$this->assertNull( Core::node( 'alice' ) );
		$this->assertNull( Core::node( 'bob' ) );
		$this->assertNull( Core::node( 'carol' ) );
	}

	public function test_remove_node_glob_matches_anchored_regex(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'worker-0' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'worker-1' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'leader' ] );

		$out = $interpreter->dispatch( 'remove_node', [ '-a', 'worker-\\d+' ] );

		$this->assertStringContainsString( 'removed worker-0', $out );
		$this->assertStringContainsString( 'removed worker-1', $out );
		// `leader` doesn't match the anchored pattern, must remain.
		$this->assertNotNull( Core::node( 'leader' ) );
	}

	public function test_remove_node_glob_no_matches_reports_no_matches(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'remove_node', [ '-a', 'will-never-match' ] );
		$this->assertSame( "no matches\n", $out );
	}

	public function test_remove_node_unknown_name_reports_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'remove_node', [ 'ghost' ] );
		$this->assertStringContainsString( "can't find node", $out );
		$this->assertStringContainsString( 'ghost', $out );
	}

	public function test_remove_node_refuses_to_destroy_interpreter(): void {
		// Removing _command_interpreter would crash subsequent dispatch.
		// remove_node must refuse, both via name match and via $node===$self.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'remove_node', [ '_command_interpreter' ] );
		$this->assertStringContainsString( 'refusing', $out );
		// The interpreter is still registered, ready to keep handling commands.
		$this->assertNotNull( Core::node( '_command_interpreter' ) );
	}

	public function test_remove_node_refuses_baseline_scaffolding_by_name(): void {
		// _router and _output are also baseline; even an outsider interpreter shouldn't
		// be able to delete them via this command.
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( '_router' );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'helper-interpreter' );

		$out = $interpreter->dispatch( 'remove_node', [ '_router' ] );
		$this->assertStringContainsString( 'refusing to destroy baseline', $out );
		$this->assertNotNull( Core::node( '_router' ) );
	}

	public function test_remove_node_refuses_stdout_session_scaffolding(): void {
		// _stdout is auto-mounted REPL session infra, like _output; remove_node must refuse it.
		$stdout = new \Newspack_Nodes\Stdout_Node();
		$stdout->name( \Newspack_Nodes\Node_Names::STDOUT );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'helper-interpreter' );

		$out = $interpreter->dispatch( 'remove_node', [ \Newspack_Nodes\Node_Names::STDOUT ] );
		$this->assertStringContainsString( 'refusing to destroy baseline', $out );
		$this->assertNotNull( Core::node( \Newspack_Nodes\Node_Names::STDOUT ) );
	}

	public function test_dump_config_omits_stdout_session_scaffolding(): void {
		// _stdout is auto-mounted session infra (like _output) — dump_config must skip it,
		// so a session's config dump doesn't try to reconstruct REPL plumbing.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$stdout = new \Newspack_Nodes\Stdout_Node();
		$stdout->name( \Newspack_Nodes\Node_Names::STDOUT );

		$dump = $interpreter->dispatch( 'dump_config' );
		$this->assertStringContainsString( 'make_node Capture_Sink alice', $dump );
		$this->assertStringNotContainsString( '_stdout', $dump );
	}

	public function test_dump_config_omits_shell_tap_scaffolding(): void {
		// The `_shell` console Tap is REPL plumbing (build_repl_graph), not a
		// user node — dump_config must skip it too.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$tap = new \Newspack_Nodes\Tap_Node();
		$tap->name( \Newspack_Nodes\Node_Names::CONSOLE_TAP );

		$dump = $interpreter->dispatch( 'dump_config' );
		$this->assertStringContainsString( 'make_node Capture_Sink alice', $dump );
		$this->assertStringNotContainsString( '_shell', $dump );
	}

	public function test_remove_node_empty_args_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'remove_node' );
		$this->assertStringContainsString( 'usage:', $out );
	}

	public function test_remove_node_a_flag_with_no_pattern_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'remove_node', [ '-a' ] );
		$this->assertStringContainsString( 'usage:', $out );
	}

	public function test_help_covers_every_dispatchable_verb(): void {
		// Contract: every entry in $C (interpreter dispatch table) MUST be resolvable
		// through `help <verb>` — either directly via $H or through the
		// alias→canonical map. A regression that adds a verb without help
		// would land here as a failed assertion telling us which key.
		$ref = new \ReflectionClass( Command_Interpreter_Node::class );

		// Force initialization of $C and $H (init_C is private and lazy).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'help' );

		$c_prop = $ref->getProperty( 'C' );
		$verbs = \array_keys( $c_prop->getValue() );

		foreach ( $verbs as $verb ) {
			$out = $interpreter->dispatch( 'help', [ "$verb" ] );
			$this->assertStringNotContainsString(
				'no such topic',
				$out,
				"verb '$verb' is dispatchable but has no help entry"
			);
		}
	}

	public function test_help_renders_node_schema_for_a_node_type(): void {
		// `help <NodeType>` surfaces the node_schema — description, category,
		// arguments WITH their descriptions, verbs — not just command help.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'help', [ 'Partition' ] );

		$this->assertStringNotContainsString( 'no such topic', $out );
		$this->assertStringContainsString( 'I/O', $out );            // category
		$this->assertStringContainsString( 'min_segments', $out );   // an argument
		$this->assertStringContainsString( 'hard minimum of 2', $out ); // its description
	}

	public function test_help_covers_every_shell_builtin(): void {
		// Shell builtins never reach $C (Shell intercepts them before sending),
		// but they're user-typeable so help must still cover them. Mirrors the
		// list in Shell::parse + the prefix-aware verb cases.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$shell_builtins = [
			'cd', 'chdir',
			'tell', 'tell_node',
			'send', 'send_node',
			'send_eof',
			'command', 'cmd', 'command_node',
			'request', 'request_node',
			'ping',
			'pwd',
			'include',
		];
		foreach ( $shell_builtins as $verb ) {
			$out = $interpreter->dispatch( 'help', [ "$verb" ] );
			$this->assertStringNotContainsString(
				'no such topic',
				$out,
				"shell builtin '$verb' is user-typeable but has no help entry"
			);
		}
	}

	public function test_remove_node_calls_node_remove_node_method(): void {
		// Use a Partition (which has a meaningful remove_node override) and
		// confirm the override fires. After remove, the file handles close —
		// the simplest observable side effect is that the node is no longer
		// in the registry.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$tmp = $this->make_temp_dir();
		try {
			// Only the required args (base_dir, partition); the base arguments()
			// setter now leaves segment_size/max_segments/max_lifetime at their
			// real schema defaults instead of overwriting them with placeholder
			// strings — so this short form constructs successfully.
			$interpreter->dispatch( 'make_node', [ "Partition", "mypart", "{$tmp}", "0" ] );
			$this->assertInstanceOf( \Newspack_Nodes\Partition_Node::class, Core::node( 'mypart' ) );

			$interpreter->dispatch( 'remove_node', [ 'mypart' ] );
			$this->assertNull( Core::node( 'mypart' ) );
		} finally {
			$this->rmdir_recursive( $tmp );
		}
	}

	public function test_ls_returns_node_table(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );

		$out = $interpreter->dispatch( 'ls' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out );
	}

	public function test_ls_default_mode_shows_only_siblings(): void {
		// Default mode = nodes whose sink IS this interpreter.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		// alice + bob auto-sink to _command_interpreter via make_node.
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );

		// Wire bob → alice so bob's sink is no longer the interpreter.
		$interpreter->dispatch( 'set_sink', [ 'bob', 'alice' ] );

		$out = $interpreter->dispatch( 'ls' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringNotContainsString( 'bob', $out, 'ls without -a hides nodes whose sink is not this interpreter' );
	}

	public function test_ls_dash_a_shows_all_nodes(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'set_sink', [ 'bob', 'alice' ] );

		$out = $interpreter->dispatch( 'ls', [ '-a' ] );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out );
		$this->assertStringContainsString( '_command_interpreter', $out );
	}

	public function test_ls_dash_a_with_glob_filters_by_regex(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alex' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );

		$out = $interpreter->dispatch( 'ls', [ '-a', '^al' ] );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'alex', $out );
		$this->assertStringNotContainsString( 'bob', $out );
	}

	public function test_ls_with_node_name_shows_nodes_sinking_into_it(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'hub' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'leaf1' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'leaf2' ] );
		$interpreter->dispatch( 'set_sink', [ 'leaf1', 'hub' ] );
		$interpreter->dispatch( 'set_sink', [ 'leaf2', 'hub' ] );

		$out = $interpreter->dispatch( 'ls', [ 'hub' ] );
		$this->assertStringContainsString( 'leaf1', $out );
		$this->assertStringContainsString( 'leaf2', $out );
		$this->assertStringNotContainsString( 'hub' . "\n", "$out\n", 'hub itself is NOT listed (its sink is the interpreter, not hub)' );
	}

	public function test_ls_with_unknown_name_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'ls', [ 'nonexistent' ] );
		$this->assertStringContainsString( "can't find node", $out );
	}

	public function test_ls_dash_c_shows_count_column(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'ls', [ '-c' ] );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'NAME', $out );
		$this->assertStringContainsString( 'alice', $out );
	}

	public function test_help_no_args_lists_commands(): void {
		// Listing uses canonical names per Tachikoma convention — aliases like
		// `ls` and `dump` are documented in their canonical entry's help text.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'help' );
		$this->assertStringContainsString( 'list_nodes', $out );
		$this->assertStringContainsString( 'help', $out );
		$this->assertStringContainsString( 'make_node', $out );
		$this->assertStringContainsString( 'dump_node', $out );
		$this->assertStringContainsString( 'ping', $out );
	}

	public function test_help_alias_resolves_to_canonical_topic(): void {
		// `help ls` should return list_nodes' help text.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'help', [ 'dump' ] );
		$this->assertStringContainsString( 'dump_node', $out );
		$this->assertStringContainsString( 'alias: dump', $out );
	}

	public function test_help_topic_returns_help_text(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'help', [ 'ls' ] );
		$this->assertStringContainsString( 'list_nodes', $out );
		$this->assertStringContainsString( '-c show', $out );
	}

	public function test_help_unknown_topic_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'help', [ 'nonsense' ] );
		$this->assertStringContainsString( 'no such topic', $out );
	}

	/** Build an envelope carrying KEY=completion (the tab-completion flag). */
	private function completion_envelope(): array {
		$m                 = Message::new_message();
		$m[ Message::KEY ] = 'completion';
		return $m;
	}

	public function test_help_completion_returns_bare_sorted_verb_names(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out   = $interpreter->dispatch( 'help', [], $this->completion_envelope() );
		// Terminated output: drop the trailing empty element explode leaves.
		$lines = \explode( "\n", \rtrim( $out, "\n" ) );

		$this->assertContains( 'list_nodes', $lines );
		$this->assertContains( 'make_node', $lines );
		$this->assertContains( 'help', $lines );
		// Aliases are typeable too, so completion offers them alongside canonicals.
		$this->assertContains( 'ls', $lines );
		$this->assertContains( 'rm', $lines );
		$this->assertContains( 'make', $lines );
		// No section headers, no per-topic help text.
		$this->assertStringNotContainsString( '###', $out );
		$this->assertStringNotContainsString( 'SERVER COMMANDS', $out );
		$this->assertStringNotContainsString( 'TM_PING', $out );
		// Sorted, newline-separated.
		$sorted = $lines;
		\sort( $sorted );
		$this->assertSame( $sorted, $lines );
	}

	public function test_help_without_completion_key_lists_all_commands_in_one_section(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'help' );
		// One unified section; the former separate SHELL BUILTINS list is folded in.
		$this->assertStringContainsString( '### COMMANDS ###', $out );
		$this->assertStringNotContainsString( '### SHELL BUILTINS ###', $out );
		// Shell builtins now appear in the single command table.
		$this->assertStringContainsString( 'send_struct', $out );
		$this->assertStringContainsString( 'debug_level', $out );
	}

	public function test_help_grid_chunks_names_four_per_row(): void {
		// The empty-topic help lays the sorted command names out four per row,
		// top-to-bottom, with only the final row allowed to be short.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		// Terminated output: drop the trailing empty element explode leaves.
		$lines = \explode( "\n", \rtrim( $interpreter->dispatch( 'help' ), "\n" ) );
		$this->assertSame( '### COMMANDS ###', $lines[0] );

		$grid  = \array_slice( $lines, 1 );
		$names = [];
		foreach ( $grid as $i => $line ) {
			$cols = \preg_split( '/\s+/', \trim( $line ) );
			if ( $i < \count( $grid ) - 1 ) {
				$this->assertCount( 4, $cols, 'every full row holds exactly four names' );
			} else {
				$this->assertGreaterThanOrEqual( 1, \count( $cols ) );
				$this->assertLessThanOrEqual( 4, \count( $cols ) );
			}
			$names = \array_merge( $names, $cols );
		}

		$sorted = $names;
		\sort( $sorted );
		$this->assertSame( $sorted, $names, 'names read left-to-right, top-to-bottom in sorted order' );
	}

	public function test_custom_command_table_gets_default_help_listing_its_verbs(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'svc' );
		// A subclass-style custom table WITHOUT its own help verb.
		$interpreter->commands(
			[
				'beta'  => static fn (): string => 'b',
				'alpha' => static fn (): string => 'a',
			]
		);

		$out   = $interpreter->dispatch( 'help' );
		$lines = \explode( "\n", \rtrim( $out, "\n" ) );
		// Sorted verb names, including the injected `help` itself.
		$this->assertSame( [ 'alpha', 'beta', 'help' ], $lines );
	}

	public function test_default_help_does_not_override_a_custom_help_verb(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'svc' );
		$interpreter->commands(
			[
				'alpha' => static fn (): string => 'a',
				'help'  => static fn (): string => 'my own help',
			]
		);

		$this->assertSame( 'my own help', $interpreter->dispatch( 'help' ) );
	}

	public function test_ls_completion_returns_bare_node_names_no_columns(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );

		// -c column flag must be ignored under completion. Completion lists ALL
		// nodes (like `ls -a`), not just siblings, so `cd <tab>` can reach _-nodes.
		$out   = $interpreter->dispatch( 'ls', [ '-c' ], $this->completion_envelope() );
		$lines = \explode( "\n", $out );

		$this->assertContains( 'alice', $lines );
		$this->assertContains( 'bob', $lines );
		$this->assertContains( '_command_interpreter', $lines );
		$this->assertStringNotContainsString( 'COUNT', $out );
		$this->assertStringNotContainsString( 'NAME', $out );
	}

	public function test_ls_completion_dash_a_returns_all_bare_names(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out   = $interpreter->dispatch( 'ls', [ '-a' ], $this->completion_envelope() );
		$lines = \explode( "\n", $out );

		$this->assertContains( 'alice', $lines );
		$this->assertContains( '_command_interpreter', $lines );
		$this->assertStringNotContainsString( 'NAME', $out );
	}

	public function test_ls_without_completion_key_is_unchanged(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'ls', [ '-c' ] );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'NAME', $out );
	}

	public function test_dump_node_shows_internal_state(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		// dump_node stringifies here (display-only payload): the class name heads
		// the dump, then the pretty snapshot.
		$out = $interpreter->dispatch( 'dump_node', [ 'alice' ] );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'Capture_Sink_Node', $out );
		$this->assertStringContainsString( '"name": "alice"', $out );
		$this->assertStringContainsString( '"sink": "_command_interpreter"', $out );
	}

	public function test_dump_alias_works(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'dump', [ 'alice' ] );
		$this->assertIsString( $out );
		$this->assertStringContainsString( '"name": "alice"', $out );
	}

	public function test_dump_node_with_keys_filters_output(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'dump_node', [ 'alice', 'name' ] );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'Capture_Sink_Node', $out ); // class header always shown
		$this->assertStringContainsString( '"name": "alice"', $out );
		$this->assertStringNotContainsString( '"sink"', $out, 'unrequested keys are filtered out' );
	}

	public function test_dump_node_class_key_is_not_an_error(): void {
		// `class` heads the dump, so requesting it as a key is a no-op, not a
		// "can't find key" error.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'dump_node', [ 'alice', 'class' ] );
		$this->assertIsString( $out );
		$this->assertStringNotContainsString( "can't find key", $out );
		$this->assertStringContainsString( 'Capture_Sink_Node', $out );
	}

	public function test_dump_node_unknown_node_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'dump_node', [ 'nonexistent' ] );
		$this->assertStringContainsString( "can't find node", $out );
	}

	public function test_dump_node_unknown_key_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'dump_node', [ 'alice', 'no_such_key' ] );
		$this->assertStringContainsString( "can't find key", $out );
	}

	public function test_TM_PING_with_empty_TO_bounces_to_FROM(): void {
		// Mirrors Tachikoma CommandInterpreter.pm:94-96. When the interpreter receives
		// TM_PING with empty TO (i.e., addressed to itself after _router peeled),
		// it sets TO=FROM and forwards via sink so the message walks the
		// breadcrumb trail back to the originator.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_PING;
		$message[ Message::FROM ]      = '_output/12345';
		$message[ Message::VALUE ]     = '1234567890.123456';
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$bounced = $downstream->captured[0];
		$this->assertSame( Message::TM_PING, $bounced[ Message::TYPE ] );
		$this->assertSame( '_output/12345', $bounced[ Message::TO ], 'TM_PING bounce sets TO=FROM' );
		$this->assertSame( '1234567890.123456', $bounced[ Message::VALUE ], 'payload preserved' );
	}

	public function test_TM_EOF_with_empty_TO_bounces_to_FROM(): void {
		// TM_EOF with empty TO is a drain marker emitted by `wp nodes cli`
		// when stdin closes — the cli expects the receiving interpreter to bounce it
		// back so the cli knows all preceding output has been drained from
		// the IPC partitions before exiting. Same TO=FROM pattern as
		// TM_PING.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$message[ Message::FROM ] = '_output/12345';
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$bounced = $downstream->captured[0];
		$this->assertSame( Message::TM_EOF, $bounced[ Message::TYPE ] );
		$this->assertSame( '_output/12345', $bounced[ Message::TO ], 'TM_EOF bounce sets TO=FROM' );
	}

	public function test_TM_EOF_with_non_empty_TO_does_not_bounce(): void {
		// TM_EOF in transit toward another node: forward as-is. Only the
		// destination interpreter (where TO arrives empty after _router peels) bounces.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$message[ Message::FROM ] = '_output/12345';
		$message[ Message::TO ]   = 'somewhere_else';
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$this->assertSame( 'somewhere_else', $downstream->captured[0][ Message::TO ], 'TO preserved on transit' );
	}

	public function test_TM_PING_with_non_empty_TO_does_not_bounce(): void {
		// TM_PING with TO set (e.g., transiting through this interpreter on the way to
		// somewhere else) just forwards normally — only the destination interpreter
		// (where TO arrives empty after _router peels) does the bounce.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_PING;
		$message[ Message::FROM ] = '_output/12345';
		$message[ Message::TO ]   = 'some_other_node';
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$forwarded = $downstream->captured[0];
		$this->assertSame( 'some_other_node', $forwarded[ Message::TO ], 'TO preserved on transit' );
	}

	public function test_stats_renders_tachikoma_columns(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		// alice is a sibling (sinks into _command_interpreter via make_node).
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$alice                       = Core::node( 'alice' );
		$message                         = Message::new_message();
		$message[ Message::VALUE ]       = 'twelve bytes';
		$alice->fill( $message );

		$out = $interpreter->dispatch( 'stats' );

		// Header columns:
		$this->assertStringContainsString( 'NAME',     $out );
		$this->assertStringContainsString( 'COUNT',    $out );
		$this->assertStringContainsString( 'LGST_MSG', $out );
		$this->assertStringContainsString( 'READ',     $out );
		$this->assertStringContainsString( 'WRITTEN',  $out );
		// Per-node row: name + values. lgst_msg tracks packed-Message
		// size (not bare VALUE length); compute against the actual envelope
		// so the assertion survives Message-shape changes.
		$lgst = \strlen( Message::packed( $message ) );
		$this->assertMatchesRegularExpression(
			"/alice\\s+1\\s+{$lgst}\\s+0\\s+0/",
			$out,
			"alice row should show counter=1, lgst_msg={$lgst}, read=0, written=0"
		);
	}

	public function test_dump_metadata_includes_lgst_msg_and_byte_counters(): void {
		// CaptureSink overrides fill() to track packed-Message size — base
		// Node intentionally doesn't, so we use a tracking subclass here
		// to exercise the dump_metadata field surface.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$alice = new Capture_Sink_Node();
		$alice->name( 'alice' );

		$message                   = Message::new_message();
		$message[ Message::VALUE ] = 'twelve bytes';
		$alice->fill( $message );

		// dump_metadata returns a live PHP structure now — no JSON string to decode.
		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertIsArray( $decoded );
		$this->assertArrayHasKey( 'alice', $decoded );
		$this->assertSame(
			\strlen( Message::packed( $message ) ),
			$decoded['alice']['lgst_msg']
		);
		$this->assertSame( 0,  $decoded['alice']['bytes_read'] );
		$this->assertSame( 0,  $decoded['alice']['bytes_written'] );
	}

	public function test_dump_metadata_exposes_the_node_arguments_string(): void {
		// The Inspector's read-only Constructor view pairs the class's declared
		// positional args with the node's actual `arguments` string, so the
		// metadata row must carry it.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$alice = new Capture_Sink_Node();
		$alice->name( 'alice' );
		$alice->arguments( [ '/tmp/logs/errors.p0', '4096', '8' ] );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertSame(
			[ '/tmp/logs/errors.p0', '4096', '8' ],
			$decoded['alice']['arguments']
		);
	}

	public function test_dump_metadata_header_carries_the_request_reply_path(): void {
		// The full snapshot stamps a `_header.pwd` with the requesting session's
		// reply path (the inbound FROM == reverse_cwd) so the GUI can match it
		// against a Tee target to toggle Connect/Disconnect authoritatively.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_repl/_output/_sse:346/_output';
		$decoded                   = $interpreter->dispatch( 'dump_metadata', [], $envelope );

		$this->assertIsArray( $decoded );
		$this->assertArrayHasKey( '_header', $decoded );
		$this->assertSame( '_repl/_output/_sse:346/_output', $decoded['_header']['pwd'] );
	}

	public function test_dump_metadata_header_reports_profiling_enabled(): void {
		// The console polls dump_metadata every tick; `_header.profiling` is the
		// truth its Profiling toggle self-heals against (Router_Node::profiles()
		// null-check). Enabled here so the assertion pins the non-default value.
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Router_Node::profiles( [] );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_repl/_output/_sse:346/_output';
		$decoded                   = $interpreter->dispatch( 'dump_metadata', [], $envelope );

		$this->assertTrue( $decoded['_header']['profiling'] );
		Router_Node::profiles( null );
	}

	public function test_dump_metadata_header_reports_profiling_disabled(): void {
		Router_Node::profiles( null );
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$decoded = $interpreter->dispatch( 'dump_metadata', [], Message::new_message() );

		$this->assertFalse( $decoded['_header']['profiling'] );
	}

	public function test_dump_metadata_single_node_refresh_omits_the_header(): void {
		// A single-node refresh is a delta, not a full snapshot — no header.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$alice = new Capture_Sink_Node();
		$alice->name( 'alice' );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_repl/_output/_sse:346/_output';
		$decoded                   = $interpreter->dispatch( 'dump_metadata', [ 'alice' ], $envelope );

		$this->assertArrayNotHasKey( '_header', $decoded );
	}

	public function test_dump_metadata_class_is_the_unqualified_short_name(): void {
		// The `class` field is the shell name (short name minus `_Node`) the GUI
		// renders, never the fully-qualified `Newspack_Nodes\Tests\Capture_Sink_Node`.
		// This pins the contract so the basename computation can't regress to the FQCN.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$alice = new Capture_Sink_Node();
		$alice->name( 'alice' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertIsArray( $decoded );
		$this->assertArrayHasKey( 'alice', $decoded );
		$this->assertSame( 'Capture_Sink', $decoded['alice']['class'] );
	}

	public function test_dump_metadata_class_is_the_registered_shell_name(): void {
		// The `class` field is the SHELL name the GUI catalog keys on, which
		// differs from the class short-name when they diverge (Echo_Node → 'Echo').
		// The JS Inspector does `catalog.find( c => c.shell_name === node.class )`
		// and `node.class === 'Tee'`, so reporting the short-name 'Echo_Node'
		// would break schema lookup + Tee detection on the canvas.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$node = new Echo_Node();
		$node->name( 'e1' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertSame( 'Echo', $decoded['e1']['class'] );
	}

	public function test_response_echoes_the_request_arguments(): void {
		// The response VALUE carries `arguments` so a targeted reply (e.g.
		// `dump_metadata <node>`) is distinguishable from a full one by `_metadata`.
		$interpreter = new Command_Interpreter_Node();
		$sink        = new Capture_Sink_Node();
		$interpreter->sink( $sink );
		$interpreter->commands( [ 'echo' => fn ( $self, $args ) => 'echoed: ' . \implode( ' ', $args ) ] );

		$message = $this->command_message( 'echo', 'hi', true );
		$interpreter->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$value = $sink->captured[0][ Message::VALUE ];
		$this->assertSame( 'echo', $value['name'] );
		$this->assertSame( [ 'hi' ], $value['arguments'] );
		$this->assertSame( 'echoed: hi', $value['payload'] );
	}

	public function test_dump_metadata_with_node_arg_returns_only_that_node(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$keep = new Capture_Sink_Node();
		$keep->name( 'keep' );
		$other = new Capture_Sink_Node();
		$other->name( 'other' );

		$decoded = $interpreter->dispatch( 'dump_metadata', [ 'keep' ] );

		$this->assertSame( [ 'keep' ], \array_keys( $decoded ) );
	}

	public function test_dump_metadata_with_unknown_node_returns_empty_map(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$keep = new Capture_Sink_Node();
		$keep->name( 'keep' );

		$this->assertSame( [], $interpreter->dispatch( 'dump_metadata', [ 'ghost' ] ) );
	}

	public function test_uptime_under_one_minute_shows_seconds_only(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + 42;
		$this->assertStringContainsString( 'up 42s', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_minute_pads_single_digit_seconds(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + 7;
		$this->assertStringContainsString( 'up 07s', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_hour_pads_single_digit_seconds(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 4 * 60 ) + 7;
		$this->assertStringContainsString( 'up 4m 07s', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_hour_shows_minutes_and_seconds(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 4 * 60 ) + 12;
		$this->assertStringContainsString( 'up 4m 12s', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_day_pads_single_digit_minutes(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 2 * 3_600 ) + ( 5 * 60 );
		$this->assertStringContainsString( 'up 2h 05m', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_uptime_under_one_day_shows_hours_and_minutes(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 2 * 3_600 ) + ( 35 * 60 );
		$this->assertStringContainsString( 'up 2h 35m', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_uptime_over_one_day_shows_days_and_hms(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + ( 3 * 86_400 ) + ( 4 * 3_600 ) + ( 5 * 60 ) + 6;
		$this->assertStringContainsString( 'up 3d 04:05:06', $interpreter->dispatch( 'uptime' ) );
	}

	public function test_dump_config_round_trips_full_graph(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'connect_node', [ 'alice', 'bob' ] );

		$dump = $interpreter->dispatch( 'dump_config' );
		$this->assertStringContainsString( 'make_node Capture_Sink alice', $dump );
		$this->assertStringContainsString( 'make_node Capture_Sink bob', $dump );
		$this->assertStringContainsString( 'connect_node alice bob', $dump );
		// alice's sink is _command_interpreter (auto-default) — should NOT be emitted.
		$this->assertStringNotContainsString( 'set_sink alice', $dump );
	}

	public function test_dump_config_glob_filters_by_node_name(): void {
		// Tachikoma: `dump_config [<regex glob>]` dumps only nodes whose name
		// matches the glob (regex). No glob dumps everything.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );

		$dump = $interpreter->dispatch( 'dump_config', [ 'ali' ] );
		$this->assertStringContainsString( 'make_node Capture_Sink alice', $dump );
		$this->assertStringNotContainsString( 'bob', $dump );
	}

	public function test_dump_config_round_trips_idempotently_through_make_node(): void {
		// Tachikoma round-trip contract: dump_config -> parse + dispatch ->
		// dump_config' must be byte-identical. The schema-driven arguments()
		// setter populates each node from the dumped string, dump_config
		// re-emits the canonical raw arguments, and the second dump matches
		// the first. Uses Tee + Echo + Hook to avoid auto-wired `:config`
		// siblings (which would need cascade-cleanup outside this test's scope).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Tee', 'fanout' ] );
		$interpreter->dispatch( 'make_node', [ 'Echo', 'sink-a' ] );
		$interpreter->dispatch( 'make_node', [ 'Echo', 'sink-b' ] );
		$interpreter->dispatch( 'make_node', [ 'Hook', 'on-save', 'save_post', 'true' ] );
		$interpreter->dispatch( 'connect_node', [ 'fanout', 'sink-a' ] );
		$interpreter->dispatch( 'connect_node', [ 'fanout', 'sink-b' ] );
		$interpreter->dispatch( 'connect_node', [ 'on-save', 'fanout' ] );

		$dump1 = $interpreter->dispatch( 'dump_config' );

		foreach ( [ 'fanout', 'sink-a', 'sink-b', 'on-save' ] as $name ) {
			$interpreter->dispatch( 'remove_node', [ $name ] );
		}

		foreach ( \explode( "\n", $dump1 ) as $line ) {
			$line = \trim( $line );
			if ( '' === $line ) {
				continue;
			}
			$tokens = \preg_split( '/\s+/', $line );
			$verb   = \array_shift( $tokens );
			$interpreter->dispatch( $verb, $tokens );
		}

		$dump2 = $interpreter->dispatch( 'dump_config' );
		$this->assertSame( $dump1, $dump2, 'dump_config round-trip must be byte-identical' );
	}

	public function test_dump_config_omits_nodes_with_a_patron(): void {
		// A patron-managed sidecar (a Consumer's :source / :offsetlog) is recreated
		// by its patron's own config line, so dumping it separately would duplicate
		// it on replay. dump_config omits any node whose patron is set.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'owner' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'sidecar' ] );
		Core::node( 'sidecar' )->patron( Core::node( 'owner' ) );

		$dump = $interpreter->dispatch( 'dump_config' );
		$this->assertStringContainsString(
			'make_node Capture_Sink owner',
			$dump
		);
		$this->assertStringNotContainsString( 'sidecar', $dump );
	}

	// ── A1: instance verb table + patron pointer ─────────────────

	public function test_patron_accessor_round_trips(): void {
		$interpreter   = new Command_Interpreter_Node();
		$node = new \Newspack_Nodes\Callback_Node( static fn () => null );
		$this->assertNull( $interpreter->patron() );
		$interpreter->patron( $node );
		$this->assertSame( $node, $interpreter->patron() );
	}

	public function test_commands_accessor_replaces_verb_table(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'test_interpreter' );
		$interpreter->commands(
			[
				'echo_args' => static fn ( Command_Interpreter_Node $self, array $args ) => 'got: ' . \implode( ' ', $args ),
			]
		);
		$result = $interpreter->dispatch( 'echo_args', [ 'hello', 'world' ] );
		$this->assertSame( 'got: hello world', $result );
	}

	public function test_default_ci_still_has_default_verbs_after_refactor(): void {
		// Regression: moving $C from class-level static to instance must
		// not break the bare `_command_interpreter`'s built-in verbs.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$result = $interpreter->dispatch( 'ls' );
		$this->assertStringNotContainsString( 'unknown command', $result );
	}

	public function test_dump_metadata_skips_any_patron_linked_node(): void {
		// Patron data node — visible.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'patron_node' ] );
		$patron = \Newspack_Nodes\Core::node( 'patron_node' );

		// Non-interpreter plumbing node (e.g. mirrors Partition's Lock helper).
		$helper = new Capture_Sink_Node();
		$helper->patron( $patron );
		$helper->name( 'patron_node:helper' );

		$metadata = $interpreter->dispatch( 'dump_metadata' );

		$this->assertIsArray( $metadata );
		$this->assertArrayHasKey( 'patron_node', $metadata );
		$this->assertArrayNotHasKey(
			'patron_node:helper',
			$metadata,
			'any node with patron() set must be hidden, not just interpreters'
		);
	}

	public function test_dump_metadata_skips_a_node_whose_schema_is_hidden(): void {
		// Hook-mounted infrastructure has no owner to patron it — _connect_timer
		// is shared process-wide by every Remote_Link — so it declared
		// `hidden => true` and the canvas drew it anyway: dump_metadata read the
		// schema only for accepts_fill / has_target.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'visible_node' ] );

		$timer = new \Newspack_Nodes\Connect_Queue_Timer_Node();
		$timer->name( \Newspack_Nodes\Connect_Queue_Timer_Node::NODE_NAME );
		$this->assertNull( $timer->patron(), 'nothing patrons it — the point' );

		$metadata = $interpreter->dispatch( 'dump_metadata' );

		$this->assertIsArray( $metadata );
		$this->assertArrayHasKey( 'visible_node', $metadata );
		$this->assertArrayNotHasKey(
			\Newspack_Nodes\Connect_Queue_Timer_Node::NODE_NAME,
			$metadata,
			'a schema that says hidden must be hidden on the canvas too'
		);
	}

	public function test_dump_metadata_skips_patron_linked_sibling_interpreters(): void {
		// Patron data node — visible to the canvas.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'patron_node' ] );
		$patron = \Newspack_Nodes\Core::node( 'patron_node' );

		// Sibling interpreter — should be filtered out of dump_metadata.
		$sibling = new Command_Interpreter_Node();
		$sibling->patron( $patron );
		$sibling->name( 'patron_node:config' );

		$metadata = $interpreter->dispatch( 'dump_metadata' );

		$this->assertIsArray( $metadata );
		$this->assertArrayHasKey( 'patron_node', $metadata );
		$this->assertArrayNotHasKey( 'patron_node:config', $metadata );
	}

	public function test_dump_metadata_merges_a_nodes_extra_hook(): void {
		// A node's dump_metadata() contributes fields into its metadata row.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$node = new Extra_Metadata_Node();
		$node->name( 'extra' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertArrayHasKey( 'extra', $decoded );
		$this->assertSame( [ 'a', 'b' ], $decoded['extra']['frames'] );
		$this->assertSame( [ 'segment' => 3, 'offset' => 7 ], $decoded['extra']['cursor'] );
	}

	public function test_dump_metadata_hook_cannot_clobber_fixed_keys(): void {
		// The hook is merged with +=, so a fixed key (e.g. `class`) the hook also
		// declares is ignored — the interpreter-computed value wins.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$node = new Clobbering_Metadata_Node();
		$node->name( 'clobber' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertArrayHasKey( 'clobber', $decoded );
		$this->assertSame( 'Clobbering_Metadata', $decoded['clobber']['class'], 'fixed key survives the hook merge' );
		$this->assertSame( 99, $decoded['clobber']['extra_only'], 'a non-conflicting hook key is added' );
	}

	// ── Argument validation paths on verb handlers ────────────────

	public function test_make_node_with_too_few_args_returns_usage(): void {
		// `make_node` alone — no type, no name — must return a usage hint
		// rather than throw. Tachikoma interpreter contract: validation errors fall
		// out as plain strings, only handler exceptions go through the
		// TM_ERROR wrap in interpret().
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'make_node' );
		$this->assertStringContainsString( 'usage: make_node', $out );
	}

	public function test_make_node_with_only_type_returns_usage(): void {
		// `make_node Capture_Sink` (no name) — still under the 2-token bar.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'make_node', [ 'Capture_Sink' ] );
		$this->assertStringContainsString( 'usage: make_node', $out );
	}

	public function test_make_node_unknown_class_returns_error(): void {
		// Class shell-name resolves to no registered namespace — the cmd should
		// surface `unknown class: <type>` and NOT auto-create anything.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'make_node', [ 'NotARegisteredClass', 'alice' ] );
		$this->assertSame( "unknown class: NotARegisteredClass\n", $out );
		$this->assertNull( Core::node( 'alice' ) );
	}

	// ── cmd_set_sink error paths ──────────────────────────────────

	public function test_set_sink_missing_target_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$out = $interpreter->dispatch( 'set_sink', [ 'alice' ] );
		$this->assertStringContainsString( 'usage: set_sink', $out );
	}

	public function test_set_sink_empty_args_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'set_sink' );
		$this->assertStringContainsString( 'usage: set_sink', $out );
	}

	public function test_set_sink_unknown_node_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		// alice exists, ghost does not — both src and dst lookup go
		// through Core::node, so either being null yields 'unknown node'.
		$out = $interpreter->dispatch( 'set_sink', [ 'alice', 'ghost' ] );
		$this->assertSame( "unknown node\n", $out );

		$out = $interpreter->dispatch( 'set_sink', [ 'ghost', 'alice' ] );
		$this->assertSame( "unknown node\n", $out );
	}

	// ── cmd_connect_node error paths + envelope FROM defaulting ──

	public function test_connect_node_empty_args_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'connect_node' );
		$this->assertStringContainsString( 'usage: connect_node', $out );
	}

	public function test_connect_node_unknown_node_returns_error(): void {
		// `connect_node` with a name not in the registry: must surface
		// the not-found message rather than touch any node state.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'connect_node', [ 'ghost', 'bob' ] );
		$this->assertStringContainsString( 'unknown node: ghost', $out );
	}

	public function test_connect_node_without_target_and_without_envelope_returns_usage(): void {
		// `connect_node alice` with no envelope FROM — should fall through
		// to the second usage branch (line 325): no target supplied, no
		// FROM to default to, so the verb has nothing to bind alice to.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		// $interpreter->execute( verb, envelope=[] ) — empty envelope == empty FROM.
		$out = $interpreter->dispatch( 'connect_node', [ 'alice' ] );
		$this->assertStringContainsString( 'usage: connect_node', $out );
	}

	public function test_connect_node_defaults_to_envelope_FROM_when_target_omitted(): void {
		// Tachikoma contract: `connect_node <node>` with no target binds
		// the node back to the cli/SSE session that issued the command
		// (the message's FROM). This is the "tail this node into my
		// session" shortcut.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		// Hand-build the envelope and call execute with it.
		$envelope                       = Message::new_message();
		$envelope[ Message::FROM ]      = '_output/4242';

		$out = $interpreter->dispatch( 'connect_node', [ 'alice' ], $envelope );
		$this->assertSame( "ok\n", $out );
		$this->assertSame( '_output/4242', Core::node( 'alice' )->target() );
	}

	// ── cmd_disconnect_node error paths + Tee envelope behavior ──

	public function test_disconnect_node_empty_args_returns_usage(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'disconnect_node' );
		$this->assertStringContainsString( 'usage: disconnect_node', $out );
	}

	public function test_disconnect_node_unknown_node_returns_error(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'disconnect_node', [ 'ghost' ] );
		$this->assertStringContainsString( 'unknown node: ghost', $out );
	}

	public function test_disconnect_node_tee_with_empty_target_and_empty_envelope_returns_usage(): void {
		// `disconnect_node <tee>` with no explicit target AND no envelope
		// FROM to default to: hits the second usage branch (line 350).
		// Tees have array target(); we need the array branch to be
		// taken for this guard to fire.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Tee', 'fanout' ] );
		$tee = Core::node( 'fanout' );
		$this->assertIsArray( $tee->target() );

		$out = $interpreter->dispatch( 'disconnect_node', [ 'fanout' ] );
		$this->assertStringContainsString( 'usage: disconnect_node', $out );
	}

	public function test_disconnect_node_tee_defaults_to_envelope_FROM_when_target_omitted(): void {
		// Mirror of connect_node's default-to-FROM behavior for the
		// symmetric undo path: `disconnect_node <tee>` with no explicit
		// target should peel the issuing FROM out of the Tee's fan-out.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Tee', 'fanout' ] );

		// First wire two targets — one default, one explicit.
		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_output/9999';
		$interpreter->dispatch( 'connect_node', [ 'fanout' ], $envelope );
		$interpreter->dispatch( 'connect_node', [ 'fanout', 'other_target' ] );
		$this->assertSame( [ '_output/9999', 'other_target' ], Core::node( 'fanout' )->target() );

		// disconnect with the same envelope — should remove only the FROM.
		$out = $interpreter->dispatch( 'disconnect_node', [ 'fanout' ], $envelope );
		$this->assertSame( "ok\n", $out );
		$this->assertSame( [ 'other_target' ], \array_values( Core::node( 'fanout' )->target() ) );
	}

	// ── cmd_pwd ────────────────────────────────────────────────────

	public function test_pwd_renders_cwd_arrow_from(): void {
		// `pwd` reports the cwd token (from $args) and the issuing
		// envelope's FROM in `  <cwd> -> <from>` form.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_output/abc';

		$out = $interpreter->dispatch( 'pwd', [ '/some/path' ], $envelope );
		$this->assertSame( " /some/path -> _output/abc\n", $out );
	}

	public function test_pwd_empty_cwd_shows_slash(): void {
		// `pwd` with no args defaults to `/` (the root scope marker that
		// the Shell uses when cwd is empty).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$envelope                  = Message::new_message();
		$envelope[ Message::FROM ] = '_output/abc';

		$out = $interpreter->dispatch( 'pwd', [], $envelope );
		$this->assertSame( " / -> _output/abc\n", $out );
	}

	// ── cmd_log ───────────────────────────────────────────────────

	public function test_log_routes_args_through_core_stderr(): void {
		// `log <message>` emits its args through the Core stderr pipeline
		// (the test handler captures the text). Returns empty string —
		// `interpret()` suppresses response wrapping for that case so the
		// operator's transcript stays quiet.
		$captured = [];
		Core::set_stderr_handler(
			static function ( string $message ) use ( &$captured ): void {
				$captured[] = $message;
			}
		);

		try {
			$interpreter = new Command_Interpreter_Node();
			$interpreter->name( '_command_interpreter' );

			$out = $interpreter->dispatch( 'log', [ 'hello', 'from', 'log', 'verb' ] );
			$this->assertSame( '', $out, 'log returns empty string — caller suppresses response' );
			$this->assertCount( 1, $captured );
			// log routes through the interpreter NODE's stderr, which tags the line
			// with the node's "<name>: " midfix, then hands it to Core::stderr, which
			// applies the process-identity midfix (host argv0[pid]:) centrally. The
			// captured line carries both; the dated prefix is the real handler's job,
			// bypassed by this capture.
			$this->assertSame(
				Core::log_midfix( $interpreter->log_midfix( 'hello from log verb' ) ),
				$captured[0]
			);
		} finally {
			// Restore the bootstrap default so subsequent tests don't leak.
			Core::reset();
		}
	}

	// ── cmd_dump_node misuses ─────────────────────────────────────

	public function test_dump_node_with_empty_args_says_no_node_specified(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'dump_node' );
		$this->assertSame( "no node specified\n", $out );
	}

	// ── cmd_uptime: clock segment ─────────────────────────────────

	public function test_uptime_renders_clock_prefix_in_HHMMSS(): void {
		// The output is `HH:MM:SS  up <elapsed>` — covers the gmdate()
		// clock-segment branch that wasn't asserted on by the existing
		// uptime suite (which only checked the elapsed portion).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		// 2023-11-14T22:13:20+00:00.
		Core::$init_time = 1_700_000_000.0;
		Core::$now       = 1_700_000_000.0 + 7;

		$out = $interpreter->dispatch( 'uptime' );
		$this->assertMatchesRegularExpression( '/^\d{2}:\d{2}:\d{2}  up /', $out );
		// Core::$now == 1_700_000_007 → 22:13:27 UTC. Elapsed 7s pads to "07s".
		$this->assertStringContainsString( '22:13:27  up 07s', $out );
	}

	// ── cmd_list_nodes additional column flags ────────────────────

	public function test_ls_dash_s_shows_sink_column(): void {
		// -s flag enables the SINK column in the tabulated output.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );

		$out = $interpreter->dispatch( 'ls', [ '-s' ] );
		$this->assertStringContainsString( 'SINK', $out );
		$this->assertStringContainsString( '_command_interpreter', $out );
	}

	public function test_ls_dash_t_shows_target_column(): void {
		// -t flag enables the TARGET column.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'connect_node', [ 'alice', 'bob' ] );

		$out = $interpreter->dispatch( 'ls', [ '-t' ] );
		$this->assertStringContainsString( 'TARGET', $out );
		$this->assertStringContainsString( '-> bob', $out );
	}

	public function test_ls_dash_l_implies_count_and_target(): void {
		// -l == -ct: count column AND target column rendered together.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'connect_node', [ 'alice', 'bob' ] );

		$out = $interpreter->dispatch( 'ls', [ '-l' ] );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'TARGET', $out );
		$this->assertStringContainsString( '-> bob', $out );
	}

	public function test_ls_dash_a_with_glob_no_matches_renders_no_matches_row(): void {
		// `ls -a <glob>` with a regex that doesn't hit any node should
		// surface a `no matches` row in the output. Tabulated output goes
		// through the column-flag path even though no flags were given —
		// the no-matches branch happens regardless.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'ls', [ '-a', 'never-going-to-match-anything' ] );
		$this->assertStringContainsString( 'no matches', $out );
	}

	public function test_ls_with_target_column_for_tee_renders_comma_separated(): void {
		// Tee target() returns an array; ls -t implodes with ', '.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Tee', 'fanout' ] );
		$interpreter->dispatch( 'connect_node', [ 'fanout', 'one' ] );
		$interpreter->dispatch( 'connect_node', [ 'fanout', 'two' ] );

		$out = $interpreter->dispatch( 'ls', [ '-t' ] );
		$this->assertStringContainsString( '-> one, two', $out );
	}

	// ── cmd_stats: -a flag and missing-stats default header ───────

	public function test_stats_dash_a_shows_every_registered_node(): void {
		// `-a` flag short-circuits the sibling filter and lists every
		// node regardless of sink. Forces the `$list_matches` branch
		// in cmd_stats.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );
		$interpreter->dispatch( 'set_sink', [ 'bob', 'alice' ] );  // bob's sink isn't this interpreter.

		$out = $interpreter->dispatch( 'stats', [ '-a' ] );
		$this->assertStringContainsString( 'NAME', $out );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out, '-a includes non-sibling nodes' );
	}

	public function test_stats_dash_a_with_glob_filters_by_regex(): void {
		// Regex glob with `-a`: only nodes whose name matches the glob
		// pattern should appear. Covers the @preg_match branch inside
		// the $list_matches arm.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alex' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] );

		$out = $interpreter->dispatch( 'stats', [ '-a', '^al' ] );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'alex', $out );
		$this->assertStringNotContainsString( 'bob', $out );
	}

	public function test_stats_with_explicit_sink_name_treats_as_glob(): void {
		// `stats <name>` — no -a — should restrict rows to nodes whose
		// sink IS the named node. Covers the `$expected = $glob` branch.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'hub' ] );
		$interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'leaf1' ] );
		$interpreter->dispatch( 'set_sink', [ 'leaf1', 'hub' ] );

		$out = $interpreter->dispatch( 'stats', [ 'hub' ] );
		$this->assertStringContainsString( 'leaf1', $out );
		// hub itself sinks into the interpreter, not into hub, so the row should
		// be absent.
		$this->assertStringNotContainsString( "\nhub ", "\n$out " );
	}

	// ── cmd_trace: numeric-arg-with-second-token branch ─────

	public function test_debug_state_self_numeric_first_then_token_treats_as_node_name(): void {
		// `trace 1 something` — first arg is numeric BUT there's a second
		// token, so the "numeric-only first arg" branch is bypassed and the
		// cmd treats `1` as a node name. Since there's no node named `1`, it
		// falls into the `unknown node` arm.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$out = $interpreter->dispatch( 'trace', [ '1', '2' ] );
		$this->assertSame( "unknown node: 1\n", $out );
	}

	// ── interpret() error wrap & invalid-struct drop ─────────────

	public function test_interpret_drops_message_with_invalid_command_struct(): void {
		// TM_COMMAND with a malformed JSON VALUE — `interpret()` should
		// drop_message() rather than emit a response. The sink must not
		// see any new envelopes after the drop.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		// VALUE is the command struct directly; a bare string (not an array)
		// is malformed and must be dropped, not echoed.
		$message[ Message::VALUE ] = 'this is not a command struct';
		$interpreter->fill( $message );

		$this->assertCount( 0, $downstream->captured, 'malformed TM_COMMAND must be dropped, not echoed' );
	}

	public function test_interpret_drops_command_without_name_key(): void {
		// JSON decodes fine but no `name` key in the dict — same drop path
		// as the not-an-array case. Covers `! isset( $cmd['name'] )` arm.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [ 'arguments' => [ 'nope' ] ];
		$interpreter->fill( $message );

		$this->assertCount( 0, $downstream->captured );
	}

	public function test_interpret_wraps_handler_exceptions_as_TM_ERROR(): void {
		// Replace the verb table with a handler that throws. The interpreter must
		// catch it in interpret() and emit a TM_COMMAND|TM_ERROR response
		// back along the FROM trail, instead of crashing the worker.
		// This is the central contract for "verb handlers throw freely;
		// interpret() wraps as TM_ERROR".
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$interpreter->commands(
			[
				'boom' => static function (): string {
					throw new \RuntimeException( 'kaboom!' );
				},
			]
		);

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = '_output/777';
		$message[ Message::VALUE ] = [ 'name' => 'boom', 'arguments' => [] ];
		$message[ Message::LOCAL ] = true;
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$response = $downstream->captured[0];
		$this->assertSame(
			Message::TM_COMMAND | Message::TM_ERROR,
			$response[ Message::TYPE ],
			'thrown verb errors must be re-emitted as TM_COMMAND|TM_ERROR'
		);
		$this->assertSame( '_output/777', $response[ Message::TO ], 'response walks the FROM trail back' );
		// Response VALUE rides as a live PHP structure — no JSON string to decode.
		$payload = $response[ Message::VALUE ];
		$this->assertSame( 'boom', $payload['name'] );
		$this->assertSame( "kaboom!\n", $payload['payload'] );
	}

	public function test_interpret_responds_with_structured_array_payload(): void {
		// A verb returning an array (like dump_node / dump_metadata) must
		// produce a response whose VALUE.payload IS that array — carried as a
		// live structure, not json-encoded. And an EMPTY array result must
		// still produce a response (the `'' !== $result` suppression only
		// catches the empty-STRING case, e.g. `log`).
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$interpreter->commands(
			[
				'give_array' => static fn (): array => [ 'a' => 1, 'nested' => [ 2, 3 ] ],
				'give_empty' => static fn (): array => [],
			]
		);

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = '_output/55';
		$message[ Message::VALUE ] = [ 'name' => 'give_array', 'arguments' => [] ];
		$message[ Message::LOCAL ] = true;
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$payload = $downstream->captured[0][ Message::VALUE ];
		$this->assertSame( 'give_array', $payload['name'] );
		$this->assertSame( [ 'a' => 1, 'nested' => [ 2, 3 ] ], $payload['payload'], 'array payload rides as a live structure' );

		// Empty-array result still responds (not suppressed).
		$empty                   = Message::new_message();
		$empty[ Message::TYPE ]  = Message::TM_COMMAND;
		$empty[ Message::FROM ]  = '_output/55';
		$empty[ Message::VALUE ] = [ 'name' => 'give_empty', 'arguments' => [] ];
		$empty[ Message::LOCAL ] = true;
		$interpreter->fill( $empty );

		$this->assertCount( 2, $downstream->captured, 'an empty-array result must still produce a response' );
		$this->assertSame( [], $downstream->captured[1][ Message::VALUE ]['payload'] );
	}

	public function test_interpret_wraps_unknown_command_as_TM_ERROR(): void {
		// An unknown verb makes dispatch() throw InvalidArgumentException;
		// interpret() catches it and wraps the message as TM_COMMAND|TM_ERROR
		// so the cli renders it as an error.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = '_output/77';
		$message[ Message::VALUE ] = [ 'name' => 'i_do_not_exist', 'arguments' => [] ];
		$message[ Message::LOCAL ] = true;
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$response = $downstream->captured[0];
		$this->assertSame(
			Message::TM_COMMAND | Message::TM_ERROR,
			$response[ Message::TYPE ],
			'unknown verbs throw — interpret() wraps as TM_ERROR'
		);
		$payload = $response[ Message::VALUE ];
		$this->assertStringContainsString( 'unknown command', $payload['payload'] );
	}

	public function test_interpret_carries_ID_and_KEY_through_to_response(): void {
		// GUI clients stamp a correlation ID + KEY on outbound commands
		// and expect them mirrored on the response. Make sure interpret()
		// copies both fields (not just FROM/TO) — that's the documented
		// "application-defined correlation metadata" contract.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = '_output/42';
		$message[ Message::ID ]    = 'corr-id-123';
		$message[ Message::KEY ]   = 'gui-tag-abc';
		$message[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => [ 'Capture_Sink', 'coverage_alice' ] ];
		$message[ Message::LOCAL ] = true;
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$response = $downstream->captured[0];
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $response[ Message::TYPE ], 'authorized command yields a success response' );
		$this->assertSame( 'corr-id-123', $response[ Message::ID ] );
		$this->assertSame( 'gui-tag-abc', $response[ Message::KEY ] );
	}

	// ── fill() TM_COMMAND-with-non-empty-TO forwarding ────────────

	public function test_fill_forwards_TM_COMMAND_with_non_empty_TO_to_sink(): void {
		// A TM_COMMAND in transit — TO is still set — must be forwarded
		// through the sink (typically _router) untouched. If the interpreter
		// dispatched on transit messages, every intermediate interpreter in a
		// path-routed graph would eat commands meant for downstream peers
		// (see AGENTS.md "CommandInterpreter only handles TM_COMMAND
		// with empty TO").
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::TO ]    = 'some/path/ahead';
		$message[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => [ 'Capture_Sink', 'not_made' ] ];
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$this->assertSame( 'some/path/ahead', $downstream->captured[0][ Message::TO ], 'TO preserved on transit' );
		$this->assertNull( Core::node( 'not_made' ), 'interpreter must not dispatch a transit command' );
	}

	public function test_fill_forwards_TM_COMMAND_TM_RESPONSE_to_sink(): void {
		// Response-flavored TM_COMMAND (the reply leg) must NOT be
		// re-interpreted — otherwise the response payload would round-
		// trip into the verb table and crash. Covers the
		// `! ( $type & TM_RESPONSE )` guard in fill().
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$downstream = new Capture_Sink_Node();
		$interpreter->sink( $downstream );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => [ 'Capture_Sink', 'ghost_response' ] ];
		$interpreter->fill( $message );

		$this->assertCount( 1, $downstream->captured );
		$this->assertNull( Core::node( 'ghost_response' ), 'TM_RESPONSE must not be re-dispatched' );
	}

	// ── node_schema() ────────────────────────────────────────────

	public function test_node_schema_returns_hidden_category(): void {
		// CommandInterpreter's schema marks it Hidden so the editor's
		// palette never offers it for drag-and-drop — it's placed
		// implicitly as a sibling of patron nodes. Locks the description
		// down so future "fix" attempts that flip it to a draggable
		// category trip this test.
		$schema = Command_Interpreter_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertArrayHasKey( 'description', $schema );
		$this->assertSame( [], $schema['arguments'] );
		$this->assertSame( [], $schema['commands'] );
	}

	// ── make_node instance API: null when class not registered ───

	public function test_make_node_instance_api_returns_null_for_unregistered_class(): void {
		// The cmd_make_node verb returns "unknown class: <type>"; the
		// underlying instance API returns null. Direct unit test, since
		// the verb wraps null into the string.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertNull( $interpreter->make_node( 'NotARegisteredClassEver', 'wont_exist' ) );
		$this->assertNull( Core::node( 'wont_exist' ) );
	}

	public function test_make_node_warns_when_object_arg_filtered_out(): void {
		// Catching the silent is_scalar-filter footgun: someone passing a
		// programmatic object positionally to make_node (e.g. forgot to assign
		// $cli via a public property) gets the arg silently dropped. Surface
		// a rate-limited stderr warning that names the node type.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		// Capture_Sink is a real Node subclass registered by bootstrap.
		$interpreter->make_node( 'Capture_Sink', 'dropped_obj', new \stdClass(), 'scalar-arg' );

		$this->assertStringContainsString( 'Capture_Sink', $buf );
	}

	public function test_dmesg_returns_recent_log_tail(): void {
		// `dmesg` dumps Core's recent stderr tail — the PHP port of Perl
		// Tachikoma's dmesg (join of @RECENT_LOG). Each entry already carries
		// its trailing newline.
		Core::$recent_log = [ "alpha\n", "beta\n" ];
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->assertSame( "alpha\nbeta\n", $interpreter->dispatch( 'dmesg' ) );
	}

	public function test_dump_metadata_emits_per_node_port_flags_from_schema(): void {
		// Stdout_Node declares has_target=false (a true terminal sink) and omits
		// accepts_fill, so accepts_fill must default true. The canvas reads these per-node.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$stdout = new \Newspack_Nodes\Stdout_Node();
		$stdout->name( '_stdout' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );
		$this->assertFalse( $decoded['_stdout']['has_target'] );
		$this->assertTrue( $decoded['_stdout']['accepts_fill'] );
	}

	public function test_dump_metadata_defaults_port_flags_true_for_plain_node(): void {
		// Echo_Node inherits the base schema, which declares both flags true.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$echo = new Echo_Node();
		$echo->name( 'probe' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );
		$this->assertTrue( $decoded['probe']['accepts_fill'] );
		$this->assertTrue( $decoded['probe']['has_target'] );
	}

	public function test_dump_metadata_emits_registrations_for_node_name_listeners(): void {
		// Node-name listeners become canvas edges; closure listeners do not.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$emitter = new class() extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$emitter->name( 'emitter' );

		$listener = new Echo_Node();
		$listener->name( 'listener' );

		$emitter->register( 'EVT', 'listener' );
		$emitter->register( 'EVT', 'closure', static fn ( $p ) => $p );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertSame( [ 'EVT' => [ 'listener' ] ], $decoded['emitter']['registrations'] );
	}

	public function test_dump_metadata_omits_registrations_when_empty(): void {
		// A node with no node-name registrations carries no registrations key.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$node = new Echo_Node();
		$node->name( 'plain' );

		$decoded = $interpreter->dispatch( 'dump_metadata' );

		$this->assertArrayNotHasKey( 'registrations', $decoded['plain'] );
	}
	/**
	 * The ladder freezes DEFINITIONS; it never disables the machine. Level 1
	 * removes graph construction, 2 removes the verbs where the server mints a
	 * command on your behalf (ours is `reply_to`), 3 removes re-pointing flow.
	 * Everything already wired keeps running at every level — which is why the
	 * gate is on the verb, not on the message.
	 */
	public function test_level_one_blocks_make_node(): void {
		$i = $this->armed_interpreter();
		Core::$secure_level = 1;

		$out = $i->dispatch( 'make_node', [ 'Capture_Sink', 'nope' ], $this->command_message( 'make_node' ) );

		$this->assertStringContainsString( 'disabled at secure level 1', $out );
		$this->assertNull( Core::node( 'nope' ) );
	}

	public function test_level_two_blocks_reply_to(): void {
		$i = $this->armed_interpreter();
		Core::$secure_level = 2;

		$out = $i->dispatch( 'reply_to', [ 'somewhere', 'ls' ], $this->command_message( 'reply_to' ) );

		$this->assertStringContainsString( 'disabled at secure level 2', $out );
	}

	public function test_level_three_blocks_connect_node(): void {
		$i = $this->armed_interpreter();
		Core::$secure_level = 3;

		$out = $i->dispatch( 'connect_node', [ 'a', 'b' ], $this->command_message( 'connect_node' ) );

		$this->assertStringContainsString( 'disabled at secure level 3', $out );
	}

	/** Undeclared and unratcheted processes run every verb. */
	public function test_an_undeclared_level_blocks_nothing(): void {
		$i = $this->armed_interpreter();
		Core::$secure_level = 0;

		$i->dispatch( 'make_node', [ 'Capture_Sink', 'built' ], $this->command_message( 'make_node' ) );

		$this->assertInstanceOf( Capture_Sink_Node::class, Core::node( 'built' ) );
	}

	/** A read still reads at every level: the machine keeps working. */
	public function test_a_read_verb_survives_the_top_level(): void {
		$i = $this->armed_interpreter();
		Core::$secure_level = 3;

		$out = $i->dispatch( 'ls', [], $this->command_message( 'ls' ) );

		$this->assertIsString( $out );
		$this->assertStringNotContainsString( 'disabled', $out );
	}

	/**
	 * The ratchet: `secure` climbs and never descends, `insecure` is only
	 * available before you have secured. Ported from Tachikoma's $C{secure} /
	 * $C{insecure}.
	 */
	public function test_secure_climbs_one_level_at_a_time(): void {
		$i = $this->armed_interpreter();

		$i->dispatch( 'secure', [], $this->command_message( 'secure' ) );
		$this->assertSame( 1, Core::$secure_level );

		$i->dispatch( 'secure', [], $this->command_message( 'secure' ) );
		$this->assertSame( 2, Core::$secure_level );
	}

	/**
	 * The ratchet only refuses DESCENT, so an `insecure` process can still be
	 * secured — you may change your mind toward tighter, never toward looser.
	 * -1 is below 1, so bare `secure` lands on 1 rather than climbing to 0.
	 */
	public function test_secure_climbs_out_of_insecure(): void {
		Core::$secure_level = -1;
		$i = $this->armed_interpreter();

		$i->dispatch( 'secure', [], $this->command_message( 'secure' ) );

		$this->assertSame( 1, Core::$secure_level );
	}

	public function test_secure_accepts_an_explicit_level(): void {
		$i = $this->armed_interpreter();

		$i->dispatch( 'secure', [ '3' ], $this->command_message( 'secure' ) );

		$this->assertSame( 3, Core::$secure_level );
	}

	public function test_secure_refuses_to_descend(): void {
		Core::$secure_level = 3;
		$i = $this->armed_interpreter();

		$out = $i->dispatch( 'secure', [ '1' ], $this->command_message( 'secure' ) );

		$this->assertStringContainsString( 'cannot lower', $out );
		$this->assertSame( 3, Core::$secure_level );
	}

	public function test_secure_caps_at_three(): void {
		Core::$secure_level = 3;
		$i = $this->armed_interpreter();

		$i->dispatch( 'secure', [], $this->command_message( 'secure' ) );

		$this->assertSame( 3, Core::$secure_level );
	}

	public function test_insecure_declares_minus_one(): void {
		$i = $this->armed_interpreter();

		$i->dispatch( 'insecure', [], $this->command_message( 'insecure' ) );

		$this->assertSame( -1, Core::$secure_level );
	}

	public function test_insecure_is_refused_once_secured(): void {
		Core::$secure_level = 1;
		$i = $this->armed_interpreter();

		$out = $i->dispatch( 'insecure', [], $this->command_message( 'insecure' ) );

		$this->assertStringContainsString( 'already secured', $out );
		$this->assertSame( 1, Core::$secure_level );
	}

	private function armed_interpreter(): Command_Interpreter_Node {
		$i = new Command_Interpreter_Node();
		$i->name( '_command_interpreter' );
		$i->sink( new Capture_Sink_Node() );
		return $i;
	}

	/**
	 * `null` means this process has no command surface at all — a graph-only
	 * script (`wp nodes ingest`, `wp nodes reqgrep`) composes nodes and never
	 * names an interpreter, so it has no policy to declare and nothing to warn
	 * about. Naming an interpreter is exactly the moment the surface exists, so
	 * that is when the level arms itself to 0: "there is a command surface here
	 * and nobody has said what policy it is under."
	 */
	public function test_naming_an_interpreter_arms_the_secure_level(): void {
		$this->assertNull( Core::$secure_level, 'a graph-only process stays null' );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertSame( 0, Core::$secure_level );
	}

	public function test_a_graph_without_an_interpreter_never_arms_it(): void {
		$node = new Capture_Sink_Node();
		$node->name( 'plain' );

		$this->assertNull( Core::$secure_level );
	}

	/** Already declared: naming another interpreter must not reset the policy. */
	public function test_arming_does_not_overwrite_a_declared_level(): void {
		Core::$secure_level = 2;

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$this->assertSame( 2, Core::$secure_level );
	}

}

/** Fixture: a node that contributes extra dump_metadata fields via the generic hook. */
final class Extra_Metadata_Node extends Node {
	public function dump_metadata(): array {
		return [ 'frames' => [ 'a', 'b' ], 'cursor' => [ 'segment' => 3, 'offset' => 7 ] ];
	}
}

/** Fixture: a node whose hook tries (and fails, via +=) to clobber the fixed `class` key. */
final class Clobbering_Metadata_Node extends Node {
	public function dump_metadata(): array {
		return [ 'class' => 'HIJACK', 'extra_only' => 99 ];
	}

}

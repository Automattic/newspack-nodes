<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/** Fixture: a node that auto-wires a :config sibling (handler-bearing verb + Schema_Reflection). */
final class Config_Sibling_Node extends Node {
	use \Newspack_Nodes\Schema_Reflection;
	public function __construct() {
		$this->auto_wire_interpreter();
	}
	public function interpreter(): \Newspack_Nodes\Command_Interpreter_Node {
		return $this->interpreter;
	}
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'commands' => [
				[ 'name' => 'noop', 'handler' => static fn ( $interpreter, string $args ): string => 'ok' ],
			],
		] );
	}
}

#[CoversClass( Node::class )]
class NodeTest extends TestCase {
	public function test_notify_without_a_payload_sends_an_empty_string_not_null(): void {
		// TM_INFO VALUEs are strings. A bare notify() would otherwise overwrite
		// new_message()'s '' default with null and hand a subscriber a null VALUE.
		$listener = new Capture_Sink_Node();
		$listener->name( 'reload-listener' );
		$emitter = new \Newspack_Nodes\Timer_Node();
		$emitter->name( 'signal-source' );
		$emitter->register( 'FIRE', 'reload-listener' );

		$emitter->notify( 'FIRE' );

		$this->assertCount( 1, $listener->captured );
		$this->assertSame( '', $listener->captured[0][ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_dump_metadata_defaults_to_empty(): void {
		// Base hook contributes no extra metadata; subclasses override to add fields.
		$n = new Capture_Sink_Node();
		$this->assertSame( [], $n->dump_metadata() );
	}

	public function test_name_set_and_get(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$this->assertSame( 'alice', $n->name() );
		$this->assertSame( $n, Core::node( 'alice' ) );
	}

	public function test_rename_updates_registry(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$n->name( 'bob' );
		$this->assertNull( Core::node( 'alice' ) );
		$this->assertSame( $n, Core::node( 'bob' ) );
	}

	public function test_rename_collision_throws(): void {
		$n1 = new Capture_Sink_Node();
		$n1->name( 'alice' );
		$n2 = new Capture_Sink_Node();
		$this->expectException( \RuntimeException::class );
		$n2->name( 'alice' );
	}

	public function test_sink_set_and_get(): void {
		$src = new Capture_Sink_Node();
		$dst = new Capture_Sink_Node();
		$src->sink( $dst );
		$this->assertSame( $dst, $src->sink() );
	}

	public function test_target_set_and_get(): void {
		$n = new Capture_Sink_Node();
		$n->target( 'next-node' );
		$this->assertSame( 'next-node', $n->target() );
	}

	public function test_fill_increments_counter_before_dispatch(): void {
		$n   = new Capture_Sink_Node();
		$message = Message::new_message();
		$n->fill( $message );
		$this->assertSame( 1, $n->counter() );
	}

	public function test_default_fill_forwards_to_sink(): void {
		$src = new class extends Node {}; // default fill() forwards
		$dst = new Capture_Sink_Node();
		$src->sink( $dst );

		$message                       = Message::new_message();
		$message[ Message::VALUE ]     = 'payload';
		$src->fill( $message );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'payload', $dst->captured[0][ Message::VALUE ] );
	}

	public function test_stamp_message_sets_from_when_empty(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message = Message::new_message();
		$this->assertTrue( $n->stamp_message( $message, 'alice' ) );
		$this->assertSame( 'alice', $message[ Message::FROM ] );
	}

	public function test_stamp_message_prepends_to_existing_from(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'bob' );
		$message                     = Message::new_message();
		$message[ Message::FROM ]    = 'alice';
		$this->assertTrue( $n->stamp_message( $message, 'bob' ) );
		$this->assertSame( 'bob/alice', $message[ Message::FROM ] );
	}

	public function test_stamp_message_drops_if_FROM_exceeds_MAX_FROM_SIZE(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'x' );
		$message                  = Message::new_message();
		$message[ Message::FROM ] = \str_repeat( 'a/', 600 ); // ~1200 chars
		$this->assertFalse( $n->stamp_message( $message, 'x' ) );
	}

	public function test_drop_message_format(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                     = Message::new_message();
		$message[ Message::TYPE ]    = Message::TM_INFO;
		$message[ Message::FROM ]    = 'producer';
		$message[ Message::TO ]      = 'consumer';
		$message[ Message::VALUE ]   = 'data';
		$n->drop_message( $message, 'BAD_INPUT' );
		$this->assertStringContainsString( 'WARNING: BAD_INPUT', $buf );
		$this->assertStringContainsString( 'TM_INFO', $buf );
		$this->assertStringContainsString( 'from: producer', $buf );
		$this->assertStringContainsString( 'to: consumer', $buf );
		$this->assertStringContainsString( 'payload: data', $buf );
	}

	/**
	 * The drop line JSON-encodes the whole VALUE, and the Vault admin UI sends
	 * credentials as a `--auth_password=<plaintext>` token inside it. The class
	 * already owns the redaction rule — Core::is_secret_property(), applied by
	 * dump_node() — it just was not applied here.
	 */
	public function test_drop_message_redacts_secret_argument_tokens(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [
			'name'      => 'add',
			'arguments' => [ 'spoke-01', '--auth_username=admin', '--auth_password=hunter2' ],
		];

		$n->drop_message( $message, 'unauthorized: add' );

		$this->assertStringNotContainsString( 'hunter2', $buf );
		$this->assertStringContainsString( 'auth_password', $buf, 'the key stays; only the value goes' );
		$this->assertStringContainsString( 'spoke-01', $buf, 'non-secret arguments are the diagnostic' );
	}

	public function test_drop_message_redacts_a_secret_keyed_value(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [ 'name' => 'save', 'auth_password' => 'hunter2' ];

		$n->drop_message( $message, 'unauthorized: save' );

		$this->assertStringNotContainsString( 'hunter2', $buf );
	}

	public function test_drop_message_labels_noreply_flag(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_NOREPLY;
		$n->drop_message( $message, 'BAD_INPUT' );
		$this->assertStringContainsString( 'TM_COMMAND', $buf );
		$this->assertStringContainsString( 'TM_NOREPLY', $buf );
	}

	public function test_drop_message_renders_array_value_as_json(): void {
		// Under the command protocol a TM_COMMAND VALUE is a live PHP array
		// (`['name'=>,'arguments'=>,'payload'=>]`). A malformed command struct
		// reaches drop_message with an ARRAY VALUE; the audit line must
		// json-encode it for display rather than `(string)`-cast it (which
		// triggers an "Array to string conversion" warning and prints
		// "payload: Array").
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [ 'arguments' => 'nope' ];
		$n->drop_message( $message, 'invalid command struct' );
		$this->assertStringContainsString( 'payload: {"arguments":"nope"}', $buf );
		$this->assertStringNotContainsString( 'payload: Array', $buf );
	}

	public function test_drop_message_renders_array_value_with_invalid_utf8_instead_of_blank_payload(): void {
		// A struct VALUE nested string may carry raw non-UTF-8 bytes (e.g. a
		// latin1 SQL fragment). Before this fix, the json-encode fallback's
		// (string) cast silently swallowed the encode failure to '' — the
		// audit line for a DROPPED message would print an empty "payload: ",
		// hiding exactly the byte that caused the trouble.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [ 'sql' => "WHERE name = 'Caf\xE9'" ];
		$n->drop_message( $message, 'invalid command struct' );
		$this->assertStringContainsString( 'payload: {"sql":"WHERE name = \'Caf', $buf, 'the bad byte is substituted, not swallowed to an empty payload' );
	}

	public function test_drop_message_uses_bitwise_test_for_combined_flags(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = 'should-show';
		$n->drop_message( $message, 'X' );
		$this->assertStringContainsString( 'payload: should-show', $buf );
	}

	public function test_register_throws_on_undeclared_event(): void {
		$n = new class extends Node {};
		$n->name( 'p' );
		$this->expectException( \RuntimeException::class );
		$n->register( 'NEVER', 'listener' );
	}

	public function test_register_and_notify_with_closure_listener(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'PING' => [] ];
			}
		};
		$n->name( 'p' );
		$received = null;
		$n->register( 'PING', 'cb', function ( $payload ) use ( &$received ) { $received = $payload; } );
		$n->notify( 'PING', 'hello' );
		$this->assertSame( 'hello', $received );
	}

	public function test_register_replays_cached_state_to_late_subscribers(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
			public function make_ready(): void {
				$this->set_state( 'READY', $this->name );
			}
		};
		$n->name( 'p' );
		$n->make_ready();

		$received = null;
		$n->register( 'READY', 'late', function ( $payload ) use ( &$received ) { $received = $payload; } );
		$this->assertSame( 'p', $received );
	}

	public function test_notify_dispatches_to_node_name_via_TM_INFO(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'p' );
		$listener = new Capture_Sink_Node();
		$listener->name( 'l' );
		$n->register( 'EVT', 'l' );
		$n->notify( 'EVT', 'payload-x' );

		$this->assertCount( 1, $listener->captured );
		$message = $listener->captured[0];
		$this->assertSame( Message::TM_INFO, $message[ Message::TYPE ] );
		$this->assertSame( 'EVT', $message[ Message::KEY ] );
		$this->assertSame( 'payload-x', $message[ Message::VALUE ] );
		// Delivered directly to the resolved node with empty TO; stamping TO=listener
		// re-routes through _router — across an SSE session boundary it lands where neither the
		// listener nor the emitter exist, logging a spurious NOT_AVAILABLE.
		$this->assertSame( '', $message[ Message::TO ] );
	}

	public function test_registered_listeners_returns_node_name_listeners_only(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [], 'OTHER' => [] ];
			}
		};
		$n->name( 'emitter' );
		$n->register( 'EVT', 'node_listener' ); // null cb => node-name dispatch
		$n->register( 'EVT', 'closure_listener', static fn ( $p ) => $p ); // closure => excluded

		$this->assertSame( [ 'EVT' => [ 'node_listener' ] ], $n->registered_listeners() );
	}

	public function test_registered_listeners_omits_events_with_no_node_name_listeners(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'emitter' );
		$n->register( 'EVT', 'closure_only', static fn ( $p ) => $p );

		$this->assertSame( [], $n->registered_listeners() );
	}

	public function test_debug_state_default_zero_no_trace_emitted(): void {
		// Baseline: with debug_state=0, set_state emits NO debug trace (the stderr
		// fan-out is silent until explicitly enabled).
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
			public function make_ready(): void {
				$this->set_state( 'READY', $this->name );
			}
		};
		$n->name( 'producer' );
		\Newspack_Nodes\Core::$recent_log = [];
		$this->assertSame( 0, $n->debug_state(), 'default off' );
		$n->make_ready();

		$this->assertEmpty( \Newspack_Nodes\Core::$recent_log, 'no trace emitted at level 0' );
	}

	public function test_debug_state_level_1_emits_trace_to_stderr(): void {
		// Level 1: set_state fires the normal notify AND additionally emits a flat
		// Tachikoma-style `DEBUG: <event> <payload>` line to stderr (Core::$recent_log),
		// but only when a _router is registered (i.e. inside a live graph).
		$router = new Capture_Sink_Node();
		$router->name( '_router' );
		\Newspack_Nodes\Core::$recent_log = [];

		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
			public function make_ready(): void {
				$this->set_state( 'READY', $this->name );
			}
		};
		$n->name( 'producer' );
		$n->debug_state( 1 );
		$n->make_ready();

		$this->assertNotEmpty( \Newspack_Nodes\Core::$recent_log );
		$this->assertStringContainsString(
			'DEBUG: READY producer',
			\implode( "\n", \Newspack_Nodes\Core::$recent_log )
		);
	}

	public function test_debug_state_silent_when_no_router_registered(): void {
		// Defensive: nodes constructed in isolation (unit tests, ad-hoc
		// scripts) often have no _router registered. set_state with
		// debug_state on must not crash — silent no-op for the trace path;
		// the normal notify still fires.
		$received = null;
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
			public function make_ready(): void {
				$this->set_state( 'READY', $this->name );
			}
		};
		$n->name( 'producer' );
		$n->debug_state( 1 );
		$n->register( 'READY', 'subscriber', function ( $p ) use ( &$received ) { $received = $p; } );
		$n->make_ready();

		// notify still ran (state cache replays to the late subscriber);
		// no trace was emitted because _router isn't registered.
		$this->assertSame( 'producer', $received );
	}

	public function test_debug_state_clamps_to_non_negative(): void {
		// debug_state is always >= 0; negative values clamp to 0 (off).
		$n = new Node();
		$this->assertSame( 0, $n->debug_state(), 'default' );
		$this->assertSame( 2, $n->debug_state( 2 ) );
		$this->assertSame( 0, $n->debug_state( -1 ), 'negative clamps to 0' );
	}

	public function test_unregister_removes_listener(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'p' );
		$received = 0;
		$n->register( 'EVT', 'cb', function () use ( &$received ) { ++$received; } );
		$n->notify( 'EVT', null );
		$n->unregister( 'EVT', 'cb' );
		$n->notify( 'EVT', null );
		$this->assertSame( 1, $received );
	}

	public function test_closure_falsy_return_unregisters(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'p' );
		$count = 0;
		$n->register( 'EVT', 'once', function () use ( &$count ) { ++$count; return false; } );
		$n->notify( 'EVT', null );
		$n->notify( 'EVT', null );
		$this->assertSame( 1, $count, 'Returning falsy single-shots the registration' );
	}

	public function test_connect_node_sets_owner(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'src' );
		$n->connect_node( 'dst' );
		$this->assertSame( 'dst', $n->target() );
	}

	public function test_disconnect_node_clears_owner(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'src' );
		$n->connect_node( 'dst' );
		$n->disconnect_node();
		$this->assertSame( '', $n->target() );
	}

	public function test_remove_node_unregisters_and_clears_state(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$dst = new Capture_Sink_Node();
		$n->sink( $dst );
		$n->connect_node( 'someone' );

		$n->remove_node();

		$this->assertNull( Core::node( 'alice' ) );
		$this->assertSame( '', $n->name() );
		$this->assertNull( $n->sink() );
		$this->assertSame( '', $n->target() );
	}

	public function test_dump_config_emits_make_node(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$out = $n->dump_config();
		$this->assertStringContainsString( "make_node Capture_Sink alice", $out );
	}

	public function test_dump_config_suppresses_set_sink_for_default_command_interpreter_sink(): void {
		$interpreter = new Capture_Sink_Node();
		$interpreter->name( '_command_interpreter' );
		$n  = new Capture_Sink_Node();
		$n->name( 'alice' );
		$n->sink( $interpreter );

		$out = $n->dump_config();
		$this->assertStringNotContainsString( 'set_sink', $out );
	}

	public function test_dump_config_emits_set_sink_when_sink_overridden(): void {
		$other = new Capture_Sink_Node();
		$other->name( 'other' );
		$n     = new Capture_Sink_Node();
		$n->name( 'alice' );
		$n->sink( $other );

		$out = $n->dump_config();
		$this->assertStringContainsString( 'set_sink alice other', $out );
	}

	public function test_dump_config_emits_connect_node(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$n->connect_node( 'bob' );
		$out = $n->dump_config();
		$this->assertStringContainsString( 'connect_node alice bob', $out );
	}

	// ── A1: sibling-interpreter plumbing ──────────────────────────────

	public function test_config_sibling_synced_with_patron_name(): void {
		$patron  = new Config_Sibling_Node();
		$sibling = $patron->interpreter();

		$patron->name( 'alice' );

		$this->assertSame( 'alice', $patron->name() );
		$this->assertSame( 'alice:config', $sibling->name() );
		$this->assertSame( $sibling, $patron->interpreter() );
	}

	public function test_setting_sink_cascades_to_sibling_interpreter(): void {
		$patron     = new Config_Sibling_Node();
		$sibling    = $patron->interpreter();
		$downstream = new Capture_Sink_Node();

		$patron->sink( $downstream );

		// Rule #2: the sibling `:config` CI inherits the patron's sink so it
		// isn't a dead end — its verb responses (sent via `$this->sink?->fill()`)
		// route back through the same hop. Mirrors how name() keeps it synced.
		$this->assertSame( $downstream, $patron->sink() );
		$this->assertSame( $downstream, $sibling->sink() );
	}

	public function test_node_without_interpreter_name_unaffected(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'bob' );
		$this->assertSame( 'bob', $n->name() );
		$this->assertNull( \Newspack_Nodes\Core::node( 'bob:config' ) );
	}

	public function test_auto_wired_config_sibling_is_initially_unnamed_then_adopts_patron_name(): void {
		// The sibling is built at construction (before the node is named), so it
		// starts unnamed and adopts {patron}:config when the patron is named.
		$patron = new Config_Sibling_Node();
		$this->assertInstanceOf( \Newspack_Nodes\Command_Interpreter_Node::class, $patron->interpreter() );
		$this->assertSame( '', $patron->interpreter()->name() );

		$patron->name( 'preset' );
		$this->assertSame( 'preset:config', $patron->interpreter()->name() );
	}

	// ── A1: node_schema() manifest ───────────────────────────

	public function test_node_schema_default_returns_empty_manifest(): void {
		$schema = Node::node_schema();
		$this->assertIsArray( $schema );
		$this->assertSame( '', $schema['category'] );
		$this->assertSame( '', $schema['description'] );
		$this->assertSame( [], $schema['arguments'] );
		$this->assertSame( [], $schema['commands'] );
	}

	public function test_remove_node_cascades_sibling_unregistration(): void {
		$patron  = new Config_Sibling_Node();
		$sibling = $patron->interpreter();
		$patron->name( 'alice' );

		$this->assertSame( $sibling, Core::node( 'alice:config' ) );
		$patron->remove_node();
		$this->assertNull( Core::node( 'alice' ) );
		$this->assertNull(
			Core::node( 'alice:config' ),
			'sibling :config must be unregistered when patron removed'
		);
	}

	// ── byte counters and arguments() round-trip ─────────────────────────

	public function test_bytes_read_defaults_to_zero(): void {
		// Logic nodes (Tee, Hook, app subclasses) leave bytes_read at 0;
		// only I/O nodes (Partition, Consumer) populate it. Accessor must
		// surface the protected slot value.
		$n = new Capture_Sink_Node();
		$this->assertSame( 0, $n->bytes_read() );
	}

	public function test_bytes_read_reflects_protected_property(): void {
		// Inject a non-zero bytes_read via reflection (mimicking what a
		// Partition / Consumer would do internally) and verify the public
		// accessor reads back through.
		$n   = new Capture_Sink_Node();
		$ref = new \ReflectionProperty( \Newspack_Nodes\Node::class, 'bytes_read' );
		$ref->setValue( $n, 12345 );
		$this->assertSame( 12345, $n->bytes_read() );
	}

	public function test_bytes_written_defaults_to_zero(): void {
		$n = new Capture_Sink_Node();
		$this->assertSame( 0, $n->bytes_written() );
	}

	public function test_bytes_written_reflects_protected_property(): void {
		$n   = new Capture_Sink_Node();
		$ref = new \ReflectionProperty( \Newspack_Nodes\Node::class, 'bytes_written' );
		$ref->setValue( $n, 98765 );
		$this->assertSame( 98765, $n->bytes_written() );
	}

	public function test_arguments_get_set_roundtrip(): void {
		// arguments() with no arg returns the stored value; with an arg sets
		// and returns the new value. dump_config() reads this field to emit
		// the `make_node Foo bar <args>` line.
		$n = new Capture_Sink_Node();
		$this->assertSame( [], $n->arguments(), 'default is empty' );
		$this->assertSame( [ '/path/to/foo', '2' ], $n->arguments( [ '/path/to/foo', '2' ] ) );
		$this->assertSame( [ '/path/to/foo', '2' ], $n->arguments(), 'value persists after set' );
	}

	public function test_dump_config_includes_stored_arguments(): void {
		// dump_config emits `make_node Class name <arguments>` — verifying
		// arguments() is round-trippable through the config snippet.
		$n = new Capture_Sink_Node();
		$n->name( 'mynode' );
		$n->arguments( [ '/var/log', '/partition', '0' ] );

		$out = $n->dump_config();
		$this->assertStringContainsString( 'make_node Capture_Sink mynode /var/log /partition 0', $out );
	}

	public function test_base_arguments_is_a_plain_setter_with_no_schema_walk(): void {
		// The base arguments() is the trivial Tachikoma getter/setter: it stores
		// the raw string and does NOT walk node_schema()['arguments']. A node that
		// wants positional assignment calls parse_schema_args() (the I/O overrides
		// do); one that declares args but never asks for the walk gets nothing
		// assigned — no implicit-walk footgun.
		$node = new class() extends Node {
			public string $base = '';
			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'arguments' => [ [ 'name' => 'base', 'type' => 'string' ] ],
				] );
			}
		};
		$this->assertSame( [ '/tmp/x' ], $node->arguments( [ '/tmp/x' ] ) );
		$this->assertSame( '', $node->base, 'base arguments() must NOT auto-walk the schema' );
	}

	public function test_parse_schema_args_assigns_declared_positional_config(): void {
		// The schema walk lives in the Schema_Reflection trait's parse_schema_args();
		// calling it assigns each declared positional prop (coerced to its type).
		$node = new class() extends Node {
			use \Newspack_Nodes\Schema_Reflection;
			public string $base   = '';
			public int $partition = -1;
			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}
			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'arguments' => [
						[ 'name' => 'base',      'type' => 'string' ],
						[ 'name' => 'partition', 'type' => 'int', 'default' => 0 ],
					],
				] );
			}
		};
		$node->parse( [ '/tmp/x', '3' ] );
		$this->assertSame( '/tmp/x', $node->base );
		$this->assertSame( 3, $node->partition );
	}

	// ── patron() getter/setter ───────────────────────────────────────────

	public function test_patron_returns_null_by_default(): void {
		$n = new Capture_Sink_Node();
		$this->assertNull( $n->patron(), 'patron defaults to null' );
	}

	public function test_patron_setter_records_passed_node(): void {
		// Patron pointer is set on plumbing nodes — sibling interpreters and Lock /
		// heartbeat helpers Partition creates inside a running event loop.
		// dump_metadata filters any node with patron() !== null from the
		// canvas feed.
		$plumbing = new Capture_Sink_Node();
		$primary  = new Capture_Sink_Node();
		$plumbing->patron( $primary );

		$this->assertSame( $primary, $plumbing->patron() );
	}

	public function test_patron_getter_does_not_overwrite_when_null_arg(): void {
		// Calling patron() with no arg (or explicit null) returns current
		// value without overwriting. Same pattern as sink() and target()
		// accessors.
		$plumbing = new Capture_Sink_Node();
		$primary  = new Capture_Sink_Node();
		$plumbing->patron( $primary );

		// Re-call with null → must NOT clear the patron.
		$this->assertSame( $primary, $plumbing->patron( null ) );
		$this->assertSame( $primary, $plumbing->patron() );
	}

	// ── interpreter() getter ─────────────────────────────────────────────

	public function test_interpreter_returns_null_when_unattached(): void {
		// Nodes without sibling-interpreter plumbing return null from interpreter().
		$n = new Capture_Sink_Node();
		$ref = new \ReflectionClass( $n );
		$this->assertNull( $ref->getProperty( 'interpreter' )->getValue( $n ) );
	}

	// ── stamp_message empty-name guard ───────────────────────────────────

	public function test_stamp_message_returns_false_on_empty_name(): void {
		// Spec: "A node with no name (mid-construction or post-rename)
		// emitting `/from` paths breaks Router. Drop with print_less_often
		// instead." stamp_message() with empty $name must return false
		// without mutating the message.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );

		$n   = new Capture_Sink_Node();
		$message = Message::new_message();
		$message[ Message::FROM ] = 'preexisting';

		$this->assertFalse( $n->stamp_message( $message, '' ) );
		$this->assertSame( 'preexisting', $message[ Message::FROM ], 'FROM must NOT be mutated' );
		$this->assertStringContainsString( 'stamp_message() called with empty name', $buf );
	}

	// ── dump_node() reflection-based snapshot ────────────────────────────

	public function test_dump_node_includes_declared_properties(): void {
		// dump_node() reflects every initialized property; default Node
		// fields (name, target, counter, …) must appear in the snapshot.
		$n = new Capture_Sink_Node();
		$n->name( 'snapshot-test' );
		$n->target( 'somewhere' );

		$snap = $n->dump_node();

		$this->assertIsArray( $snap );
		$this->assertArrayHasKey( 'name', $snap );
		$this->assertSame( 'snapshot-test', $snap['name'] );
		$this->assertArrayHasKey( 'target', $snap );
		$this->assertSame( 'somewhere', $snap['target'] );
		$this->assertArrayHasKey( 'counter', $snap );
		$this->assertSame( 0, $snap['counter'] );
	}

	public function test_dump_node_includes_the_runtime_class_name(): void {
		// The snapshot carries the node's own (runtime) class short name so
		// cmd_dump_node can head the dump with it.
		$snap = ( new Capture_Sink_Node() )->dump_node();
		$this->assertArrayHasKey( 'class', $snap );
		$this->assertSame( 'Capture_Sink_Node', $snap['class'] );
	}

	public function test_dump_node_redacts_secret_named_properties(): void {
		// dump_node() reflects EVERY property, so a node holding a credential
		// (an Application Password, a bearer token) would print it raw to the
		// REPL / logs — a disclosure vector. The base redacts secret-named
		// properties for every node, so no node author has to remember to.
		// Non-secret look-alikes (username, an `authorize` flag) must survive,
		// and an empty secret stays empty so the operator sees it's unset.
		$node = new class() extends Node {
			public string $auth_token    = 'super-secret-bearer';
			public string $auth_password = 'hunter2';
			public array $api_tokens     = [ 'a', 'b' ];
			public string $auth_username = 'admin';
			public bool $authorize       = true;
			public string $secret        = '';
			public array $credentials    = [];
		};

		$snap = $node->dump_node();

		$this->assertSame( '[REDACTED]', $snap['auth_token'], 'a non-empty token must be redacted' );
		$this->assertSame( '[REDACTED]', $snap['auth_password'], 'a non-empty password must be redacted' );
		$this->assertSame( '[REDACTED]', $snap['api_tokens'], 'a non-empty array of secrets must be redacted, not dumped raw' );
		$this->assertSame( 'admin', $snap['auth_username'], 'a username is not a secret' );
		$this->assertTrue( $snap['authorize'], 'an authorize flag is not a secret' );
		$this->assertSame( '', $snap['secret'], 'an empty secret stays empty, not [REDACTED]' );
		$this->assertSame( [], $snap['credentials'], 'an empty credential stays empty, not [REDACTED]' );
	}

	public function test_dump_node_collapses_sink_to_node_name_string(): void {
		// dump_node() replaces the sink object reference with the sink's
		// name() string — the special-cased branch right before the generic
		// object-to-class-name fallback. Without this, the sink would
		// render as `(CaptureSink)` losing the relationship info.
		$src = new Capture_Sink_Node();
		$dst = new Capture_Sink_Node();
		$dst->name( 'sink-name' );
		$src->sink( $dst );

		$snap = $src->dump_node();
		$this->assertArrayHasKey( 'sink', $snap );
		$this->assertSame( 'sink-name', $snap['sink'], 'sink object collapses to its name string' );
	}

	public function test_dump_node_collapses_arbitrary_object_to_class_name(): void {
		// Non-sink object properties render as `(FQCN)`. We construct an
		// ad-hoc Node subclass with an extra object property to drive this
		// branch.
		$n = new class extends \Newspack_Nodes\Node {
			public ?\stdClass $helper = null;
		};
		$n->helper = new \stdClass();

		$snap = $n->dump_node();
		$this->assertArrayHasKey( 'helper', $snap );
		$this->assertSame( '(stdClass)', $snap['helper'] );
	}

	public function test_dump_node_collapses_resource_to_debug_string(): void {
		// Spec: resources aren't JSON-encodable; dump_node coerces them
		// to `(resource:<type>)` so json_encode doesn't fail on the
		// whole snapshot. Was: dumping a Partition with open file
		// handles returned an empty payload silently.
		$n = new class extends \Newspack_Nodes\Node {
			/** @var resource|null */
			public $stream = null;
		};
		$n->stream = \fopen( 'php://memory', 'r+' );

		try {
			$snap = $n->dump_node();
			$this->assertArrayHasKey( 'stream', $snap );
			$this->assertStringStartsWith( '(resource:', $snap['stream'] );
		} finally {
			if ( \is_resource( $n->stream ) ) {
				\fclose( $n->stream );
			}
		}
	}

	// ── drop_message branches ────────────────────────────────────────────

	public function test_drop_message_routes_NOT_AVAILABLE_to_less_often(): void {
		// Spec: "First-300s NOT_AVAILABLE rule" — when uptime (Core::$now -
		// Core::$init_time) < 300 and the error is 'NOT_AVAILABLE', drop_message
		// routes through print_less_often (suppresses until 10th occurrence)
		// instead of print_less_often (emits first then suppresses 60s). This
		// dampens boot-time noise from nodes that haven't been registered yet.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );

		$n   = new Capture_Sink_Node();
		$n->name( 'q' );
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_INFO;
		$message[ Message::TO ]   = 'nobody-home';

		// Single call should emit
		$n->drop_message( $message, 'NOT_AVAILABLE' );
		$this->assertStringContainsString( 'NOT_AVAILABLE', $buf, 'first NOT_AVAILABLE in boot window is not suppressed' );
	}

	public function test_drop_message_handles_empty_FROM_and_TO_fields(): void {
		// drop_message must not crash when FROM and TO are both empty
		// strings — the conditional appends skip them and the warning
		// just contains the error + type.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );

		$n   = new Capture_Sink_Node();
		$n->name( 'q' );
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$n->drop_message( $message, 'TEST_ERROR' );

		$this->assertStringContainsString( 'WARNING: TEST_ERROR', $buf );
		$this->assertStringContainsString( 'TM_BYTESTREAM', $buf );
		$this->assertStringNotContainsString( 'from:', $buf );
		$this->assertStringNotContainsString( 'to:', $buf );
	}

	public function test_drop_message_does_not_emit_payload_for_pure_control_type(): void {
		// PAYLOAD_TYPES bitmask covers TM_INFO|TM_REQUEST|TM_ERROR|TM_COMMAND.
		// A pure TM_BYTESTREAM message must NOT emit a "payload:" suffix
		// even with a non-empty VALUE.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );

		$n = new Capture_Sink_Node();
		$n->name( 'q' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'should-not-appear';
		$n->drop_message( $message, 'X' );

		$this->assertStringNotContainsString(
			'payload:',
			$buf,
			'TM_BYTESTREAM is not in PAYLOAD_TYPES — payload must be suppressed'
		);
	}

	// ── notify on unregistered event ─────────────────────────────────────

	public function test_notify_on_unregistered_event_is_silent_noop(): void {
		// notify() on an event with no listeners (and no pre-declared
		// registration) must return without throwing. The `! isset` guard.
		$n = new Capture_Sink_Node();
		$n->name( 'p' );

		// No expectation other than no exception.
		$n->notify( 'NONEXISTENT', 'data' );
		$this->assertTrue( true );
	}

	public function test_notify_unregisters_dead_node_listener(): void {
		// Node-name dispatch where the named target is gone (forgot to
		// unregister) → dispatch_listener returns false → the registration
		// is silently dropped on this notify call. Subsequent notifies
		// have zero listeners.
		$producer = new class extends \Newspack_Nodes\Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$producer->name( 'producer' );
		$listener = new Capture_Sink_Node();
		$listener->name( 'listener' );

		$producer->register( 'EVT', 'listener' );

		// Manually pull `listener` out of Core's registry to simulate a
		// listener that died without unregistering.
		Core::unregister_node( 'listener' );

		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$producer->notify( 'EVT', 'data' );

		$this->assertStringContainsString( 'forgot to unregister', $buf );

		// The dead registration is now removed — verify by reflecting on
		// the registrations array.
		$ref = new \ReflectionProperty( $producer, 'registrations' );
		$regs = $ref->getValue( $producer );
		$this->assertArrayNotHasKey( 'listener', $regs['EVT'], 'dead listener pruned on notify' );
	}

	// ── debug_state passthrough getter ───────────────────────────────────

	public function test_debug_state_getter_returns_current_level(): void {
		// debug_state() with no arg returns the current level (already
		// covered by clamp test in passing, but worth a focused getter
		// assertion).
		$n = new \Newspack_Nodes\Node();
		$n->debug_state( 3 );
		$this->assertSame( 3, $n->debug_state() );
	}

	// ── target() getter when no arg ──────────────────────────────────────

	public function test_target_getter_returns_current_value_when_called_without_arg(): void {
		$n = new Capture_Sink_Node();
		// Default value is '' (empty string).
		$this->assertSame( '', $n->target() );
		$n->target( 'somewhere' );
		// Calling again with no arg returns the stored value.
		$this->assertSame( 'somewhere', $n->target() );
	}

	// ── log_midfix / stderr / print_*_often (per-node) ───────────────────

	public function test_log_midfix_adds_node_name_tag(): void {
		// A named node tags every emitted line with "<name>: " (Tachikoma
		// Node::log_midfix). With a message it chomps, prepends the midfix
		// to every line, and returns the result + a single trailing newline.
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$this->assertSame( "alice: hello\n", $n->log_midfix( 'hello' ) );
	}

	public function test_log_midfix_no_args_returns_bare_tag(): void {
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$this->assertSame( 'alice: ', $n->log_midfix() );
	}

	public function test_log_midfix_unnamed_node_is_empty(): void {
		// An unnamed node has no tag (Tachikoma guards on $self->{name}).
		$n = new \Newspack_Nodes\Node();
		$this->assertSame( '', $n->log_midfix() );
		$this->assertSame( "hello\n", $n->log_midfix( 'hello' ) );
	}

	public function test_log_midfix_empty_when_argv0_starts_with_name(): void {
		// Tachikoma suppresses the midfix when $0 (process identity) already
		// begins with the node name, so the prefix wouldn't be redundant.
		$old = $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] ?? null;
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE'] = 'alice-worker';
		try {
			$n = new \Newspack_Nodes\Node();
			$n->name( 'alice' );
			$this->assertSame( '', $n->log_midfix() );
			$this->assertSame( "hello\n", $n->log_midfix( 'hello' ) );
		} finally {
			if ( null === $old ) {
				unset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
			} else {
				$_SERVER['NEWSPACK_NODES_WORKER_TYPE'] = $old;
			}
		}
	}

	public function test_log_midfix_prepends_tag_to_every_line(): void {
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$this->assertSame( "alice: one\nalice: two\n", $n->log_midfix( "one\ntwo" ) );
	}

	public function test_stderr_emits_name_tagged_message_through_core_seam(): void {
		// Node::stderr applies its own "<name>: " tag, then routes through
		// Core::stderr, which applies the process-identity midfix (host argv0[pid]:)
		// centrally. So the handler sees both: the core midfix wrapping the
		// node-tagged text. The dated prefix (log_prefix) is added after, by the
		// real handler; this capture handler bypasses it.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$n->stderr( 'a warning' );
		$this->assertSame( Core::log_midfix( $n->log_midfix( 'a warning' ) ), $buf );
	}

	public function test_stderr_empty_message_emits_nothing(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$n->stderr( '' );
		$this->assertSame( '', $buf );
	}

	public function test_print_less_often_emits_once_per_node(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$n->print_less_often( 'repeated' );
		$n->print_less_often( 'repeated' );
		$this->assertSame( 1, \substr_count( $buf, 'repeated' ) );
		// The emitted line carries the node's midfix tag.
		$this->assertStringContainsString( 'alice: repeated', $buf );
	}

	public function test_print_less_often_keyed_per_node_not_shared(): void {
		// Two differently-named nodes logging the same text must NOT collide
		// on the shared rate-limiter: the midfixed KEY differs, so both emit.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$alice = new \Newspack_Nodes\Node();
		$alice->name( 'alice' );
		$bob = new \Newspack_Nodes\Node();
		$bob->name( 'bob' );
		$alice->print_less_often( 'same text' );
		$bob->print_less_often( 'same text' );
		$this->assertStringContainsString( 'alice: same text', $buf );
		$this->assertStringContainsString( 'bob: same text', $buf );
		$this->assertSame( 2, \substr_count( $buf, 'same text' ) );
	}

	public function test_print_less_often_throttles_on_prefix_only_and_prints_varying_payload(): void {
		// Tachikoma semantics: the throttle key is the FIRST arg (the stable
		// category); the varying payload args are printed on the first
		// occurrence but never widen the key — so a flood of the same category
		// with different values collapses to ONE emission (not one per value).
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'seq' );
		$n->print_less_often( 'INFO: duplicate message: expected #', '1', ', got #', '5' );
		$n->print_less_often( 'INFO: duplicate message: expected #', '2', ', got #', '9' );
		$n->print_less_often( 'INFO: duplicate message: expected #', '3', ', got #', '7' );
		$this->assertSame( 1, \substr_count( $buf, 'duplicate message' ), 'flood collapses to one emission under the stable prefix' );
		$this->assertStringContainsString( 'expected #1, got #5', $buf, 'the one emission carries the first payload (extra args are printed, not dropped)' );
	}

	public function test_drop_message_throttles_on_category_not_the_varying_address(): void {
		// drop_message bakes the per-message FROM/TO into its audit line. If those
		// widened the throttle key, a drop storm (same error + type, different
		// senders) would emit one line per sender — loudest exactly when the storm
		// is worst. The stable error+type category is what must key the throttle.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'router' );
		foreach ( [ 'alpha/7', 'bravo/19', 'charlie/23' ] as $origin ) {
			$msg                       = Message::new_message();
			$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
			$msg[ Message::FROM ]      = $origin;
			$msg[ Message::TO ]        = 'nowhere/' . $origin;
			$n->drop_message( $msg, 'message not addressed' );
		}
		$this->assertSame( 1, \substr_count( $buf, 'message not addressed' ), 'a drop storm with varying senders collapses to one audit line under the stable error+type category' );
		$this->assertStringContainsString( 'from: alpha/7', $buf, 'the one emission carries the first message\'s address payload' );
	}

	// ---- Schema_Reflection trait auto-wires the sibling :config interpreter (opt-in) -----

	public function test_node_with_schema_handlers_auto_wires_config_interpreter(): void {
		$node = new class() extends Node {
			use \Newspack_Nodes\Schema_Reflection;
			public function __construct() {
				$this->auto_wire_interpreter();
			}
			public function interpreter(): \Newspack_Nodes\Command_Interpreter_Node {
				return $this->interpreter;
			}
			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'commands' => [
						[
							'name'    => 'ping_back',
							'handler' => static fn ( $interpreter, string $args ): string => 'pong:' . $args,
						],
					],
				] );
			}
		};
		$node->name( 'demo-node' );

		$interpreter = $node->interpreter();
		$this->assertInstanceOf( \Newspack_Nodes\Command_Interpreter_Node::class, $interpreter );
		$this->assertSame( 'demo-node:config', $interpreter->name() );
		$this->assertSame( $node, $interpreter->patron() );
		$this->assertArrayHasKey( 'ping_back', $interpreter->commands() );
	}

	public function test_node_without_schema_handlers_has_no_config_interpreter(): void {
		// Base node_schema declares no verbs → no sibling interpreter.
		$n = new Node();
		$ref = new \ReflectionClass( $n );
		$this->assertNull( $ref->getProperty( 'interpreter' )->getValue( $n ) );
	}

	public function test_schema_verb_without_handler_does_not_wire_an_interpreter(): void {
		// A catalog-only verb (no handler) must not spawn a sibling interpreter,
		// even when the node opts into auto-wiring.
		$node = new class() extends Node {
			use \Newspack_Nodes\Schema_Reflection;
			public function __construct() {
				$this->auto_wire_interpreter();
			}
			public function interpreter(): \Newspack_Nodes\Command_Interpreter_Node|null {
				return $this->interpreter;
			}
			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'commands' => [ [ 'name' => 'doc_only' ] ],
				] );
			}
		};
		$this->assertNull( $node->interpreter() );
	}

	public function test_command_interpreter_does_not_get_a_sibling_interpreter(): void {
		// An interpreter dispatches its own verbs; it must never attach a sibling :config interpreter.
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$ref = new \ReflectionClass( $interpreter );
		$this->assertNull( $ref->getProperty( 'interpreter' )->getValue( $interpreter ) );
	}

	public function test_auto_wire_is_idempotent_across_a_double_call(): void {
		// A node that calls auto_wire_interpreter() more than once must NOT build a
		// second sibling — the auto-wire skips when an interpreter is already attached.
		$node = new class() extends Node {
			use \Newspack_Nodes\Schema_Reflection;
			public function __construct() {
				$this->auto_wire_interpreter();
				$this->auto_wire_interpreter();
			}
			public function interpreter(): \Newspack_Nodes\Command_Interpreter_Node {
				return $this->interpreter;
			}
			public static function node_schema(): array {
				return \array_merge( parent::node_schema(), [
					'commands' => [
						[
							'name'    => 'noop',
							'handler' => static fn ( $interpreter, string $args ): string => 'ok',
						],
					],
				] );
			}
		};
		$first = $node->interpreter();
		$this->assertInstanceOf( \Newspack_Nodes\Command_Interpreter_Node::class, $first );
		// Second parent call must not have replaced the first interpreter.
		$this->assertSame( $first, $node->interpreter() );
	}

	// ── func_num_args getter/setter split + Perl length() presence ───────

	public function test_name_no_args_is_pure_getter(): void {
		// name() with NO args is a pure getter: it must not touch the registry.
		$n = new Capture_Sink_Node();
		$n->name( 'kept' );
		$this->assertSame( 'kept', $n->name() );
		$this->assertSame( $n, Core::node( 'kept' ) );
	}

	public function test_name_setter_registers_and_returns_new_name(): void {
		$n = new Capture_Sink_Node();
		$this->assertSame( 'x', $n->name( 'x' ) );
		$this->assertSame( $n, Core::node( 'x' ) );
	}

	public function test_name_zero_string_registers_node_named_zero(): void {
		// Headline length()-test guarantee: '0' IS a value, so `make_node Echo 0`
		// must register a node literally named "0". Plain truthiness would drop it.
		$n = new Capture_Sink_Node();
		$n->name( '0' );
		$this->assertSame( '0', $n->name() );
		$this->assertSame( $n, Core::node( '0' ) );
	}

	public function test_name_empty_string_throws(): void {
		// A named node is committed to a name until remove_node(); name('')
		// is not an unregister path — it throws.
		$n = new Capture_Sink_Node();
		$n->name( 'gone' );
		$this->expectException( \RuntimeException::class );
		$n->name( '' );
	}

	public function test_name_null_throws(): void {
		// null is the other "no value" input — name(null) throws too.
		$n = new Capture_Sink_Node();
		$n->name( 'gone' );
		$this->expectException( \RuntimeException::class );
		$n->name( null );
	}

	public function test_name_throw_leaves_existing_name_intact(): void {
		// A rejected name('') must not have unregistered the node first.
		$n = new Capture_Sink_Node();
		$n->name( 'keep' );
		try {
			$n->name( '' );
		} catch ( \RuntimeException $e ) {
			// expected
		}
		$this->assertSame( 'keep', $n->name() );
		$this->assertSame( $n, Core::node( 'keep' ) );
	}

	public function test_rename_cascades_config_sibling(): void {
		// Renaming renames the :config sibling to {new}:config and unregisters the old.
		$node = new Config_Sibling_Node();
		$node->name( 'first' );
		$this->assertSame( 'first:config', $node->interpreter()->name() );
		$this->assertSame( $node->interpreter(), Core::node( 'first:config' ) );

		$node->name( 'second' );
		$this->assertSame( 'second:config', $node->interpreter()->name() );
		$this->assertSame( $node->interpreter(), Core::node( 'second:config' ) );
		$this->assertNull( Core::node( 'first:config' ) );
	}

	public function test_remove_node_clears_config_sibling(): void {
		// remove_node() (not name(null)) is the teardown path; it unregisters
		// the node and cascades to its :config sibling.
		$node = new Config_Sibling_Node();
		$node->name( 'host' );
		$this->assertSame( $node->interpreter(), Core::node( 'host:config' ) );

		$node->remove_node();
		$this->assertNull( Core::node( 'host' ) );
		$this->assertNull( Core::node( 'host:config' ) );
	}

	public function test_name_collision_throws(): void {
		$first = new Capture_Sink_Node();
		$first->name( 'dup' );
		$second = new Capture_Sink_Node();
		$this->expectException( \RuntimeException::class );
		$second->name( 'dup' );
	}

	public function test_name_config_sibling_collision_throws(): void {
		// An interpreter-bearing node naming against an occupied {name}:config throws.
		$squatter = new Capture_Sink_Node();
		$squatter->name( 'taken:config' );

		$node = new Config_Sibling_Node();
		$this->expectException( \RuntimeException::class );
		$node->name( 'taken' );
	}

	public function test_has_value_truth_table(): void {
		// Perl length()-style presence: null/'' are absent; '0' and 'x' are present.
		$probe = new class() extends Node {
			public static function probe( ?string $s ): bool {
				return Core::has_value( $s );
			}
		};
		$this->assertFalse( $probe::probe( null ) );
		$this->assertFalse( $probe::probe( '' ) );
		$this->assertTrue( $probe::probe( '0' ) );
		$this->assertTrue( $probe::probe( 'x' ) );
	}
}

<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Node::class )]
class NodeTest extends TestCase {
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
		$msg = Message::new_message();
		$n->fill( $msg );
		$this->assertSame( 1, $n->counter() );
	}

	public function test_default_fill_forwards_to_sink(): void {
		$src = new class extends Node {}; // default fill() forwards
		$dst = new Capture_Sink_Node();
		$src->sink( $dst );

		$msg                       = Message::new_message();
		$msg[ Message::VALUE ]     = 'payload';
		$src->fill( $msg );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'payload', $dst->captured[0][ Message::VALUE ] );
	}

	public function test_stamp_message_sets_from_when_empty(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'alice' );
		$msg = Message::new_message();
		$this->assertTrue( $n->stamp_message( $msg, 'alice' ) );
		$this->assertSame( 'alice', $msg[ Message::FROM ] );
	}

	public function test_stamp_message_prepends_to_existing_from(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'bob' );
		$msg                     = Message::new_message();
		$msg[ Message::FROM ]    = 'alice';
		$this->assertTrue( $n->stamp_message( $msg, 'bob' ) );
		$this->assertSame( 'bob/alice', $msg[ Message::FROM ] );
	}

	public function test_stamp_message_drops_if_FROM_exceeds_MAX_FROM_SIZE(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'x' );
		$msg                  = Message::new_message();
		$msg[ Message::FROM ] = \str_repeat( 'a/', 600 ); // ~1200 chars
		$this->assertFalse( $n->stamp_message( $msg, 'x' ) );
	}

	public function test_drop_message_format(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$msg                     = Message::new_message();
		$msg[ Message::TYPE ]    = Message::TM_INFO;
		$msg[ Message::FROM ]    = 'producer';
		$msg[ Message::TO ]      = 'consumer';
		$msg[ Message::VALUE ]   = 'data';
		$n->drop_message( $msg, 'BAD_INPUT' );
		$this->assertStringContainsString( 'WARNING: BAD_INPUT', $buf );
		$this->assertStringContainsString( 'TM_INFO', $buf );
		$this->assertStringContainsString( 'from: producer', $buf );
		$this->assertStringContainsString( 'to: consumer', $buf );
		$this->assertStringContainsString( 'payload: data', $buf );
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
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::VALUE ] = [ 'arguments' => 'nope' ];
		$n->drop_message( $msg, 'invalid command struct' );
		$this->assertStringContainsString( 'payload: {"arguments":"nope"}', $buf );
		$this->assertStringNotContainsString( 'payload: Array', $buf );
	}

	public function test_drop_message_uses_bitwise_test_for_combined_flags(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new Capture_Sink_Node();
		$n->name( 'alice' );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = 'should-show';
		$n->drop_message( $msg, 'X' );
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
		};
		$n->name( 'p' );
		$n->set_state( 'READY', 'now-ready' );

		$received = null;
		$n->register( 'READY', 'late', function ( $payload ) use ( &$received ) { $received = $payload; } );
		$this->assertSame( 'now-ready', $received );
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
		$msg = $listener->captured[0];
		$this->assertSame( Message::TM_INFO, $msg[ Message::TYPE ] );
		$this->assertSame( 'EVT', $msg[ Message::KEY ] );
		$this->assertSame( 'payload-x', $msg[ Message::VALUE ] );
	}

	public function test_debug_state_default_zero_no_trace_emitted(): void {
		// Baseline: with debug_state=0, set_state does NOT emit any trace to
		// _router (cli/SSE fan-out is silent until explicitly enabled).
		$router = new Capture_Sink_Node();
		$router->name( '_router' );

		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
		};
		$n->name( 'producer' );
		$this->assertSame( 0, $n->debug_state(), 'default off' );
		$n->set_state( 'READY', 'payload' );

		$this->assertCount( 0, $router->captured, 'no trace emitted at level 0' );
	}

	public function test_debug_state_level_1_emits_trace_to_repl_sse(): void {
		// Level 1: set_state fires the normal notify AND additionally emits
		// a TM_STRUCT trace addressed to _repl/sse so cli (with show_sse on)
		// and the SSE controller both see the transition.
		$router = new Capture_Sink_Node();
		$router->name( '_router' );

		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
		};
		$n->name( 'producer' );
		$n->debug_state( 1 );
		$n->set_state( 'READY', 'payload-x' );

		$this->assertCount( 1, $router->captured );
		$msg = $router->captured[0];
		$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
		$this->assertSame( '_repl',             $msg[ Message::TO ] );
		$this->assertSame( 'producer',          $msg[ Message::FROM ] );

		$v = $msg[ Message::VALUE ];
		$this->assertIsArray( $v );
		$this->assertSame( 'debug_state', $v['k'] );
		$this->assertSame( 'producer',    $v['node'] );
		$this->assertSame( 'READY',       $v['event'] );
		$this->assertSame( 'payload-x',   $v['value'] );
		// `class` exposes the FQCN so dashboards / readers can render
		// subclass-specific metadata without reflecting on the node itself.
		$this->assertArrayHasKey( 'class', $v );
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
		};
		$n->name( 'producer' );
		$n->debug_state( 1 );
		$n->register( 'READY', 'subscriber', function ( $p ) use ( &$received ) { $received = $p; } );
		$n->set_state( 'READY', 'still-fires' );

		// notify still ran (state cache replays to the late subscriber);
		// no trace was emitted because _router isn't registered.
		$this->assertSame( 'still-fires', $received );
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
		$ci = new Capture_Sink_Node();
		$ci->name( '_command_interpreter' );
		$n  = new Capture_Sink_Node();
		$n->name( 'alice' );
		$n->sink( $ci );

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

	// ── A1: sibling-CI plumbing ──────────────────────────────

	public function test_attach_interpreter_keeps_sibling_synced_with_patron_name(): void {
		$patron = new Capture_Sink_Node();
		$sibling = new \Newspack_Nodes\Command_Interpreter_Node();
		$sibling->patron( $patron );
		$patron->attach_interpreter( $sibling );

		$patron->name( 'alice' );

		$this->assertSame( 'alice', $patron->name() );
		$this->assertSame( 'alice:config', $sibling->name() );
		$this->assertSame( $sibling, $patron->interpreter() );
	}

	public function test_node_without_interpreter_name_unaffected(): void {
		$n = new Capture_Sink_Node();
		$n->name( 'bob' );
		$this->assertSame( 'bob', $n->name() );
		$this->assertNull( $n->interpreter() );
	}

	public function test_attach_interpreter_named_after_already_named_patron(): void {
		$patron = new Capture_Sink_Node();
		$patron->name( 'preset' );
		$sibling = new \Newspack_Nodes\Command_Interpreter_Node();
		$sibling->patron( $patron );
		$patron->attach_interpreter( $sibling );

		// Sibling adopts the patron's existing name immediately.
		$this->assertSame( 'preset:config', $sibling->name() );
	}

	// ── A1: node_schema() manifest ───────────────────────────

	public function test_node_schema_default_returns_empty_manifest(): void {
		$schema = Node::node_schema();
		$this->assertIsArray( $schema );
		$this->assertSame( '', $schema['category'] );
		$this->assertSame( '', $schema['description'] );
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
	}

	// ── A1: invoked_verbs round-trip via dump_config ─────────

	public function test_dump_config_emits_cmd_lines_for_invoked_verbs(): void {
		$patron = new Capture_Sink_Node();
		$patron->name( 'alice' );

		// Sibling pretends to exist (don't actually attach one — the
		// invoked-verb recording happens patron-side; dump_config
		// emits cmd lines regardless of whether the sibling is
		// attached, because the patron carries the record).
		$patron->mark_verb_invoked( 'enable_thing', '' );
		$patron->mark_verb_invoked( 'set_target', 'errors:partition' );

		$out = $patron->dump_config();
		$this->assertStringContainsString( 'cmd alice:config enable_thing', $out );
		$this->assertStringContainsString( 'cmd alice:config set_target errors:partition', $out );
	}

	public function test_dump_config_without_invoked_verbs_emits_no_cmd_lines(): void {
		$patron = new Capture_Sink_Node();
		$patron->name( 'bob' );

		$out = $patron->dump_config();
		$this->assertStringNotContainsString( ':config ', $out );
	}

	public function test_remove_node_cascades_sibling_unregistration(): void {
		$patron = new Capture_Sink_Node();
		$sibling = new \Newspack_Nodes\Command_Interpreter_Node();
		$sibling->patron( $patron );
		$patron->attach_interpreter( $sibling );
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
		$ref->setAccessible( true );
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
		$ref->setAccessible( true );
		$ref->setValue( $n, 98765 );
		$this->assertSame( 98765, $n->bytes_written() );
	}

	public function test_arguments_get_set_roundtrip(): void {
		// arguments() with no arg returns the stored value; with an arg sets
		// and returns the new value. dump_config() reads this field to emit
		// the `make_node Foo bar <args>` line.
		$n = new Capture_Sink_Node();
		$this->assertSame( '', $n->arguments(), 'default is empty' );
		$this->assertSame( '/path/to/foo 2', $n->arguments( '/path/to/foo 2' ) );
		$this->assertSame( '/path/to/foo 2', $n->arguments(), 'value persists after set' );
	}

	public function test_dump_config_includes_stored_arguments(): void {
		// dump_config emits `make_node Class name <arguments>` — verifying
		// arguments() is round-trippable through the config snippet.
		$n = new Capture_Sink_Node();
		$n->name( 'mynode' );
		$n->arguments( '/var/log /partition 0' );

		$out = $n->dump_config();
		$this->assertStringContainsString( 'make_node Capture_Sink mynode /var/log /partition 0', $out );
	}

	// ── patron() getter/setter ───────────────────────────────────────────

	public function test_patron_returns_null_by_default(): void {
		$n = new Capture_Sink_Node();
		$this->assertNull( $n->patron(), 'patron defaults to null' );
	}

	public function test_patron_setter_records_passed_node(): void {
		// Patron pointer is set on plumbing nodes — sibling CIs and Lock /
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
		// Nodes without sibling-CI plumbing return null from interpreter().
		$n = new Capture_Sink_Node();
		$this->assertNull( $n->interpreter() );
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
		$msg = Message::new_message();
		$msg[ Message::FROM ] = 'preexisting';

		$this->assertFalse( $n->stamp_message( $msg, '' ) );
		$this->assertSame( 'preexisting', $msg[ Message::FROM ], 'FROM must NOT be mutated' );
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

	public function test_drop_message_routes_NOT_AVAILABLE_to_least_often_in_first_300s(): void {
		// Spec: "First-300s NOT_AVAILABLE rule" — when Core::$now < 300 and
		// the error is 'NOT_AVAILABLE', drop_message routes through
		// print_least_often (suppresses until 10th occurrence) instead of
		// print_less_often (emits first then suppresses 60s). This dampens
		// boot-time noise from nodes that haven't been registered yet.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );

		// Force Core::$now to early-boot value.
		$saved_now = Core::$now;
		Core::$now = 100.0;

		try {
			$n   = new Capture_Sink_Node();
			$n->name( 'boot' );
			$msg                  = Message::new_message();
			$msg[ Message::TYPE ] = Message::TM_INFO;
			$msg[ Message::TO ]   = 'nobody-home';

			// Single call should not emit (print_least_often holds 9 occurrences).
			$n->drop_message( $msg, 'NOT_AVAILABLE' );
			$this->assertSame( '', $buf, 'first NOT_AVAILABLE in boot window must be suppressed' );

			// Same drop_message 9 more times → on the 10th, it emits.
			for ( $i = 0; $i < 9; $i++ ) {
				$n->drop_message( $msg, 'NOT_AVAILABLE' );
			}
			$this->assertStringContainsString(
				'NOT_AVAILABLE',
				$buf,
				'10th occurrence must finally emit'
			);
		} finally {
			Core::$now = $saved_now;
		}
	}

	public function test_drop_message_handles_empty_FROM_and_TO_fields(): void {
		// drop_message must not crash when FROM and TO are both empty
		// strings — the conditional appends skip them and the warning
		// just contains the error + type.
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );

		$n   = new Capture_Sink_Node();
		$n->name( 'q' );
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$n->drop_message( $msg, 'TEST_ERROR' );

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
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'should-not-appear';
		$n->drop_message( $msg, 'X' );

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
		$ref->setAccessible( true );
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

	public function test_stderr_emits_dateprefix_name_message_through_core_seam(): void {
		// Node::stderr routes through Core::stderr, which applies the dated
		// process prefix; Node::log_midfix supplies the "<name>: " tag.
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$n->stderr( 'a warning' );
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d.*\]: alice: a warning\n$/', $buf );
	}

	public function test_stderr_empty_message_emits_nothing(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$n->stderr( '' );
		$this->assertSame( '', $buf );
	}

	public function test_print_less_often_emits_once_per_node(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		$n->print_less_often( 'repeated' );
		$n->print_less_often( 'repeated' );
		$this->assertSame( 1, \substr_count( $buf, 'repeated' ) );
		// The emitted line carries the node's midfix tag.
		$this->assertStringContainsString( 'alice: repeated', $buf );
	}

	public function test_print_least_often_emits_at_tenth_call_per_node(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		$n = new \Newspack_Nodes\Node();
		$n->name( 'alice' );
		for ( $i = 0; $i < 9; ++$i ) {
			$n->print_least_often( 'rare' );
		}
		$this->assertStringNotContainsString( 'rare', $buf );
		$n->print_least_often( 'rare' ); // 10th
		$this->assertStringContainsString( 'alice: rare', $buf );
	}

	public function test_print_less_often_keyed_per_node_not_shared(): void {
		// Two differently-named nodes logging the same text must NOT collide
		// on the shared rate-limiter: the midfixed KEY differs, so both emit.
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
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
}

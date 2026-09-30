<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * ADR-26: `Command_Interpreter_Node::dispatch()` refuses every verb against
 * the role its schema declares, MANAGE when undeclared. In a worker no user
 * is current, so the verified session's scope is the whole gate, and a
 * command signed by the site's own secret carries no ceiling.
 */
#[CoversClass( Command_Interpreter_Node::class )]
#[CoversClass( Capabilities::class )]
final class VerbRoleGateTest extends TestCase {
	private string $dir = '';
	private Table_Node $table;
	private Capture_Sink_Node $sink;

	protected function setUp(): void {
		parent::setUp();
		$this->use_wpdb();
		$this->dir = $this->make_temp_dir( 'verb-role-gate-' );
		$this->use_base_dir( $this->dir );
		// A worker: no user is current, and every command must verify.
		$GLOBALS['_wp_test_current_user_id']        = 0;
		Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();
		$this->sink = new Capture_Sink_Node();
		Core::$var['partition'] = '5';
		try {
			$this->table = new Table_Node();
			$this->table->name( 'lab-9:weka' );
			$this->table->arguments( [ 'weka:p5', '4471', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->table->sink( $this->sink );
		$this->table->store( 'sku-4473', 'weka-4473' );
	}

	protected function tearDown(): void {
		Capabilities::$session_scope = null;
		unset( $GLOBALS['_wp_test_current_user_id'] );
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	/**
	 * Fill a signed TM_COMMAND into the Table's `:config` interpreter, as a
	 * worker's drain delivers one, and answer the reply's TYPE and payload.
	 *
	 * @param string      $verb  Verb name.
	 * @param string|null $scope Session scope to sign under; null signs with the site's secret.
	 * @return array{0:int,1:mixed}
	 */
	private function ask( string $verb, ?string $scope ): array {
		$m                       = Message::new_message();
		$m[ Message::TYPE ]      = Message::TM_COMMAND;
		$m[ Message::FROM ]      = 'hub-4477';
		$m[ Message::TIMESTAMP ] = \time();
		$m[ Message::VALUE ]     = [ 'name' => $verb, 'arguments' => [] ];
		if ( null === $scope ) {
			Command_Auth::sign( $m );
		} else {
			$session = Command_Auth::mint_session( $scope );
			Command_Auth::remember_session( 'spoke-4479', $session['handle'], $session['secret'] );
			Command_Auth::sign_for( 'spoke-4479', $m );
		}
		$this->sink->captured = [];
		Core::node( 'lab-9:weka:config' )->fill( $m );
		$this->assertCount( 1, $this->sink->captured, 'one reply' );
		$reply = $this->sink->captured[0];
		return [ Core::int( $reply[ Message::TYPE ] ), Core::arr( $reply[ Message::VALUE ] )['payload'] ?? null ];
	}

	public function test_a_read_session_is_refused_vacuum_on_a_worker_sqlite_table(): void {
		[ $type, $payload ] = $this->ask( 'vacuum', Capabilities::READ );

		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $type );
		$this->assertSame( "permission denied: manage capability required\n", $payload );
	}

	public function test_a_read_session_is_answered_stats(): void {
		[ $type, $payload ] = $this->ask( 'stats', Capabilities::READ );

		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $type );
		$this->assertIsArray( $payload );
		$this->assertArrayHasKey( 'INSERT', $payload );
	}

	public function test_a_tune_session_is_refused_flush_by_dispatch_before_any_wrapper(): void {
		$wrapped = [];
		Command_Interpreter_Node::$around_dispatch = static function ( Command_Interpreter_Node $ci, string $verb, \Closure $run ) use ( &$wrapped ): mixed {
			$wrapped[] = $verb;
			return $run();
		};

		[ $type, $payload ] = $this->ask( 'flush', Capabilities::TUNE );

		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $type );
		$this->assertSame( "permission denied: manage capability required\n", $payload, 'refused by the gate, not by flush()' );
		$this->assertSame( [], $wrapped, 'the refusal lands before any wrapper runs' );
		$this->assertSame( 'weka-4473', $this->table->lookup( 'sku-4473' ) );
	}

	public function test_a_site_signed_command_runs_flush(): void {
		Capabilities::$session_scope = Capabilities::READ;

		[ $type, $payload ] = $this->ask( 'flush', null );

		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $type );
		$this->assertGreaterThan( 0, Core::arr( $payload )['bytes'] ?? 0 );
		$this->assertNull( $this->table->lookup( 'sku-4473' ) );
	}

	public function test_a_base_builtin_that_only_reads_answers_a_read_session_and_the_rest_refuse(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( 'lab-9:base' );
		Capabilities::$session_scope = Capabilities::READ;

		$this->assertIsString( $interpreter->dispatch( 'pwd' ), 'pwd only reads, so READ reaches it' );
		$e = $this->caught( fn () => $interpreter->dispatch( 'make_node', [ 'Node', 'lab-9:kiwi' ] ), 'a READ session built a node' );
		$this->assertSame( 'permission denied: manage capability required', $e->getMessage() );
		$this->assertNull( Core::node( 'lab-9:kiwi' ) );
	}

	public function test_where_a_user_is_current_the_user_capability_decides(): void {
		$GLOBALS['_wp_test_current_user_id'] = 4481;
		Capabilities::$session_scope         = null;

		$e = $this->caught( fn () => Capabilities::require_verb( Capabilities::TUNE ), 'a user without the capability passed' );
		$this->assertSame( 'permission denied: tune capability required', $e->getMessage(), 'a user without the capability is refused though no ceiling stands' );

		$GLOBALS['_wp_test_current_user_can'] = [ Capabilities::cap_for( Capabilities::TUNE ) => true ];
		Capabilities::require_verb( Capabilities::TUNE );
		$this->addToAssertionCount( 1 );
	}

	public function test_where_no_user_is_current_the_ceiling_alone_decides(): void {
		Capabilities::$session_scope = null;
		Capabilities::require_verb( Capabilities::MANAGE );

		Capabilities::$session_scope = Capabilities::TUNE;
		Capabilities::require_verb( Capabilities::TUNE );
		$e = $this->caught( fn () => Capabilities::require_verb( Capabilities::MANAGE ), 'a TUNE ceiling reached MANAGE' );
		$this->assertSame( 'permission denied: manage capability required', $e->getMessage() );

		Capabilities::$session_scope = Capabilities::NONE;
		$e = $this->caught( fn () => Capabilities::require_verb( Capabilities::READ ), 'a NONE ceiling reached READ' );
		$this->assertSame( 'permission denied: read capability required', $e->getMessage() );
	}

	public function test_the_config_verbs_that_only_report_declare_read_and_the_rest_declare_nothing(): void {
		$declared = static function ( string $class ): array {
			$roles = [];
			foreach ( $class::node_schema()['commands'] as $verb ) {
				$roles[ $verb['name'] ] = $verb['capability'] ?? null;
			}
			return $roles;
		};
		$this->assertSame( [ 'stats' => Capabilities::READ, 'reset_stats' => null, 'flush' => null, 'vacuum' => null ], $declared( Table_Node::class ) );
		$this->assertSame(
			[ 'dl_list' => Capabilities::READ, 'dl_show' => Capabilities::READ, 'dl_requeue' => null, 'dl_purge' => null ],
			\array_intersect_key( $declared( \Newspack_Nodes\Consumer_Node::class ), \array_flip( [ 'dl_list', 'dl_show', 'dl_requeue', 'dl_purge' ] ) )
		);
	}
}

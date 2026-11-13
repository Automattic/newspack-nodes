<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Rest\Raw_Logs_CI_Node;
use Newspack_Nodes\Rest\Workers_CI_Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Per-command capability roles: a command may declare `'capability' => 'read'` in
 * node_schema(); unmarked commands stay `manage`. With the default map both
 * resolve manage_options — nothing changes until a site relaxes `read`.
 */
#[CoversClass( Service_CI_Node::class )]
class ServiceCiCapabilityTest extends TestCase {

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		parent::tearDown();
	}

	private function ci(): Command_Interpreter_Node {
		$ci = new class() extends Service_CI_Node {
			public static function node_schema(): array {
				return [
					'category'    => 'Control',
					'description' => 'capability test double',
					'arguments'   => [],
					'commands'    => [
						[
							'name'        => 'peek',
							'description' => 'read-only slice',
							'capability'  => 'read',
							'handler'     => static fn (): string => 'peeked',
						],
						[
							'name'        => 'kea_7801',
							'description' => 'an editor\'s write',
							'capability'  => 'wp:edit_posts',
							'handler'     => static fn (): string => 'kea answered',
						],
						[
							'name'        => 'mutate',
							'description' => 'writes state',
							'handler'     => static fn (): string => 'mutated',
						],
					],
					'requests'    => [],
				];
			}
		};
		$ci->name( 'captest:ci' );
		return $ci;
	}

	public function test_read_command_honors_a_relaxed_read_cap(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_posts' ] + $map
		);
		$GLOBALS['_wp_test_current_user_id']  = 5527;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => false ];

		$ci = $this->ci();

		$this->assertSame( 'peeked', $ci->dispatch( 'peek' ) );

		$e = $this->caught(
			fn () => $ci->dispatch( 'mutate' ),
			'an unmarked command must stay manage-gated'
		);
		$this->assertStringContainsString( 'permission denied', $e->getMessage() );
	}

	public function test_default_map_keeps_read_commands_admin_only(): void {
		$GLOBALS['_wp_test_current_user_id']  = 5527;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$ci = $this->ci();

		$this->expectException( \RuntimeException::class );
		$ci->dispatch( 'peek' );
	}

	// ---- a command may declare a WordPress capability ----

	public function test_a_command_declaring_a_wp_capability_answers_a_user_holding_it(): void {
		// A contributor: edit_posts and read, no substrate role.
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'read' => true ];
		Capabilities::$session_scope          = Capabilities::NONE;

		$this->assertSame( 'kea answered', $this->ci()->dispatch( 'kea_7801' ) );
	}

	public function test_it_refuses_a_user_without_it(): void {
		// A subscriber: read alone.
		$GLOBALS['_wp_test_current_user_id']  = 6604;
		$GLOBALS['_wp_test_current_user_can'] = [ 'read' => true ];
		Capabilities::$session_scope          = Capabilities::NONE;

		$e = $this->caught( fn () => $this->ci()->dispatch( 'kea_7801' ), 'a subscriber lacks edit_posts' );
		$this->assertSame( 'permission denied: edit_posts capability required', $e->getMessage() );
	}

	/** A worker runs with no user, so a `wp:` command has nobody to ask. */
	public function test_a_wp_command_in_a_worker_is_refused(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => true ];

		$e = $this->caught( fn () => $this->ci()->dispatch( 'kea_7801' ), 'a worker has no user' );
		$this->assertSame( 'permission denied: edit_posts requires a signed-in user', $e->getMessage() );
	}

	/**
	 * A `none` session sits below every role: whatever its user holds, every
	 * role-declared command and every base command refuses it, the READ ones
	 * included.
	 */
	public function test_a_none_session_is_refused_every_role_declared_command(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true, 'edit_posts' => true ];
		Capabilities::$session_scope          = Capabilities::NONE;

		$ci    = $this->ci();
		$base  = new Command_Interpreter_Node();
		$cases = [
			'workers list'       => [ new Workers_CI_Node(), 'list' ],
			'raw-logs list_logs' => [ new Raw_Logs_CI_Node(), 'list_logs' ],
			'peek (read)'        => [ $ci, 'peek' ],
			'mutate (manage)'    => [ $ci, 'mutate' ],
			'ls (base read)'     => [ $base, 'ls' ],
			'help (base read)'   => [ $base, 'help' ],
			'dump_node (base)'   => [ $base, 'dump_node' ],
		];
		foreach ( $cases as $label => [ $ci, $verb ] ) {
			$e = $this->caught( fn () => $ci->dispatch( $verb ), $label );
			$this->assertStringStartsWith( 'permission denied: ', $e->getMessage(), $label );
		}
	}
}

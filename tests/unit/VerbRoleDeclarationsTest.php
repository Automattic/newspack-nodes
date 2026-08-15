<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Rest\Aggregator_CI_Node;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Rest\Layouts_CI_Node;
use Newspack_Nodes\Rest\Raw_Logs_CI_Node;
use Newspack_Nodes\Rest\Settings_CI_Node;
use Newspack_Nodes\Rest\Status_CI_Node;
use Newspack_Nodes\Rest\Topologies_CI_Node;
use Newspack_Nodes\Rest\Vault_CI_Node;
use Newspack_Nodes\Rest\Workers_CI_Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Every substrate service verb states its role, and this is the statement.
 *
 * Service_CI_Node defaults an undeclared verb to MANAGE, so the whole surface
 * used to be manage BY OMISSION — which is why the log aggregator needed an
 * administrator's application password to pull a read-only stream. The table
 * below is the deliberate version of that, cut by BLAST RADIUS: `read` changes
 * nothing, `tune` writes values a schema already bounds, `manage` takes the
 * site down or hands out access.
 */
#[CoversClass( Service_CI_Node::class )]
class VerbRoleDeclarationsTest extends TestCase {

	/**
	 * Verb → role, per service CI. An entry omitted here is asserted MANAGE.
	 *
	 * @return array<string,array{0:class-string<Service_CI_Node>,1:array<string,string>}>
	 */
	public static function role_map(): array {
		$read   = Capabilities::READ;
		$tune   = Capabilities::TUNE;
		$manage = Capabilities::MANAGE;
		return [
			'status'      => [ Status_CI_Node::class, [ 'get' => $read ] ],
			'classes'     => [ Classes_CI_Node::class, [ 'list' => $read ] ],
			'raw-logs'    => [
				Raw_Logs_CI_Node::class,
				[ 'list_logs' => $read, 'log_status' => $read, 'read_message' => $read ],
			],
			'settings'    => [ Settings_CI_Node::class, [ 'get' => $read, 'set' => $tune ] ],
			'layouts'     => [ Layouts_CI_Node::class, [ 'get' => $read, 'save' => $tune ] ],
			'topologies'  => [
				Topologies_CI_Node::class,
				[
					'list'                  => $read,
					'get'                   => $read,
					'expand'                => $read,
					'save'                  => $manage,
					'delete'                => $manage,
					'activate'              => $manage,
					'deactivate'            => $manage,
					'connect_worker_input'  => $manage,
				],
			],
			'workers'     => [
				Workers_CI_Node::class,
				[
					'list'           => $read,
					'dump_graph'     => $read,
					'cleanup_status' => $read,
					'restart'        => $manage,
					// The SSE slot keepalive. Manage here would expire every
					// read-only stream — including the aggregator's — after one
					// slot TTL, which is the whole point of the read role.
					'heartbeat'      => $read,
				],
			],
			'aggregator'  => [
				Aggregator_CI_Node::class,
				[ 'summary' => $read, 'servers_status' => $read, 'probe' => $manage ],
			],
			'vault'       => [
				Vault_CI_Node::class,
				[
					'list'   => $manage,
					'get'    => $manage,
					'add'    => $manage,
					'update' => $manage,
					'delete' => $manage,
					'test'   => $manage,
				],
			],
		];
	}

	/**
	 * @param class-string<Service_CI_Node> $class
	 * @param array<string,string>          $expected
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'role_map' )]
	public function test_each_verb_declares_its_role( string $class, array $expected ): void {
		$schema = $class::node_schema();
		$seen   = [];
		foreach ( $schema['commands'] as $verb ) {
			$name          = $verb['name'];
			$seen[ $name ] = $verb['capability'] ?? Capabilities::MANAGE;
		}

		foreach ( $expected as $name => $role ) {
			$this->assertArrayHasKey( $name, $seen, "{$class} lost its `{$name}` verb" );
			$this->assertSame( $role, $seen[ $name ], "{$class}::{$name} must be `{$role}`" );
		}
	}

	/**
	 * The declaration has to BITE. `settings set` carried its own
	 * `require_manage_options()` on top of the schema role, so declaring `tune`
	 * alone would have changed nothing.
	 */
	public function test_a_tune_only_caller_reaches_settings_set_and_not_topology_activation(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'tune' => 'edit_pages', 'read' => 'edit_pages' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$settings = new Settings_CI_Node();
		$settings->name( 'settings' );
		// Reached the handler: an unknown option is a REFUSAL, not a denial.
		try {
			$settings->commands()['set']( $settings, [ 'newspack_nodes_not_a_setting', '1' ], [] );
			$this->fail( 'the handler should have rejected an unknown setting' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringNotContainsString( 'permission denied', $e->getMessage() );
			$this->assertStringContainsString( 'unknown setting', $e->getMessage() );
		}

		$topologies = new Topologies_CI_Node();
		$topologies->name( 'topologies' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/permission denied/' );
		$topologies->commands()['activate']( $topologies, [ 'combined' ], [] );
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		parent::tearDown();
	}

	/** The vault is manage BY DECISION: a scope that could edit it could re-credential the hub link. */
	public function test_no_vault_verb_is_reachable_below_manage(): void {
		foreach ( Vault_CI_Node::node_schema()['commands'] as $verb ) {
			$this->assertSame(
				Capabilities::MANAGE,
				$verb['capability'] ?? Capabilities::MANAGE,
				'vault verbs escalate; they stay manage'
			);
		}
	}
}

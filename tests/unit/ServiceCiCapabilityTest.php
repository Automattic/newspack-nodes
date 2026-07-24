<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Per-verb capability roles: a verb may declare `'capability' => 'read'` in
 * node_schema(); unmarked verbs stay `manage`. With the default map both
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

	public function test_read_verb_honors_a_relaxed_read_cap(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_posts' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => false ];

		$ci       = $this->ci();
		$commands = $ci->commands();

		$this->assertSame( 'peeked', $commands['peek']( $ci, [], [] ) );

		try {
			$commands['mutate']( $ci, [], [] );
			$this->fail( 'an unmarked verb must stay manage-gated' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'permission denied', $e->getMessage() );
		}
	}

	public function test_default_map_keeps_read_verbs_admin_only(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$ci       = $this->ci();
		$commands = $ci->commands();

		$this->expectException( \RuntimeException::class );
		$commands['peek']( $ci, [], [] );
	}
}

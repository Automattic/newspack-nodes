<?php
namespace Newspack_Nodes\Tests;

use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Service_CI_Node;

/**
 * The service CI behind `Fixture_Mcp_Door`: one verb at each role. `echo_args`
 * reads and answers its bound args, refusing a `count` of 0; `poke` needs
 * tune; `wipe` declares no role, so it needs manage.
 */
class Fixture_Mcp_CI_Node extends Service_CI_Node {

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Test fixture: the verbs an MCP door fronts.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'echo_args',
					'capability'  => Capabilities::READ,
					'description' => 'Answer the bound args.',
					'args'        => [
						[ 'name' => 'word', 'type' => 'string', 'required' => true, 'description' => 'One word, echoed back.' ],
						[ 'name' => 'count', 'type' => 'int', 'required' => false ],
						[ 'name' => 'tags', 'type' => 'string', 'required' => false, 'variadic' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args ): array => self::echo_args( $args ),
				],
				[
					'name'        => 'poke',
					'capability'  => Capabilities::TUNE,
					'description' => 'Answer `poked`.',
					'args'        => [],
					'handler'     => static fn (): string => 'poked',
				],
				[
					'name'        => 'wipe',
					'description' => 'Answer `wiped`.',
					'args'        => [],
					'handler'     => static fn (): string => 'wiped',
				],
			],
		] );
	}

	/**
	 * @param array<string,mixed> $args The bound args.
	 * @return array<string,mixed>
	 */
	private static function echo_args( array $args ): array {
		if ( 0 === ( $args['count'] ?? null ) ) {
			throw new \RuntimeException( 'count 0 echoes nothing' );
		}
		return $args;
	}
}

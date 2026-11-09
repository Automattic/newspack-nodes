<?php
/**
 * A node whose graph row carries a fact read off its arguments and the commands
 * sent to its `:config`, for pinning `Node::graph_facts()`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Tier_Facts_Node extends \Newspack_Nodes\Node {

	/**
	 * The last `set_tier`, else the first argument, beside every command seen.
	 *
	 * @param list<string>                         $args     The `make_node` arguments.
	 * @param list<array{0:string,1:list<string>}> $commands The commands sent to its `:config`.
	 * @return array<string,mixed>
	 */
	public static function graph_facts( array $args, array $commands ): array {
		$tier = $args[0] ?? '';
		foreach ( $commands as [ $verb, $tokens ] ) {
			if ( 'set_tier' === $verb ) {
				$tier = $tokens[0] ?? '';
			}
		}
		return [
			'tier' => $tier,
			'seen' => $commands,
		];
	}
}

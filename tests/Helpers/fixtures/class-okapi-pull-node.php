<?php
/**
 * A Remote_Source subclass that PREPENDS an argument, for pinning that the
 * analyzer finds a remote link by lineage and reads its arguments by the
 * concrete class's schema, the order the runtime binds them in.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Okapi_Pull_Node extends \Newspack_Nodes\Remote_Source_Node {

	/**
	 * The parent's schema with `mode` ahead of every inherited argument.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$schema              = parent::node_schema();
		$schema['arguments'] = [
			[ 'name' => 'mode', 'type' => 'string', 'required' => true ],
			...\Newspack_Nodes\Core::arr( $schema['arguments'] ),
		];
		return $schema;
	}
}

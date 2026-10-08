<?php
/**
 * A broker binding one more leading argument than Remote_Source, for pinning
 * that a reader of its pairs counts the bound arguments of the class written.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Wombat_Quad_Source_Node extends \Newspack_Nodes\Remote_Source_Node {
	/** Bound after the dead-letter root, before the pairs. */
	protected string $ledger_cap = '';

	/**
	 * Remote_Source's schema with one more bound argument before the pairs.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		$schema = parent::node_schema();
		\array_splice( $schema['arguments'], 3, 0, [ [ 'name' => 'ledger_cap', 'type' => 'string', 'required' => true ] ] );
		return $schema;
	}
}

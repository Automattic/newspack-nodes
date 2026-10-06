<?php
/**
 * A node declaring one sibling it builds, for pinning that the analyzer reads
 * a class's `owns` declaration rather than knowing which classes own what.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Wombat_Patron_Node extends \Newspack_Nodes\Node {
	/**
	 * A palette class declaring a `ledger` sibling of class Wombat_Ledger.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category' => 'Storage',
			'owns'     => [ 'ledger' => 'Wombat_Ledger' ],
		] + parent::node_schema();
	}
}

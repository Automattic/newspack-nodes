<?php
/**
 * A node off the palette declaring a sibling it owns, for pinning that the
 * analyzer refuses what the editor's catalog could never draw.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Wombat_Hidden_Patron_Node extends \Newspack_Nodes\Node {
	/**
	 * A Hidden class declaring a `ledger` sibling.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'owns'     => [ 'ledger' => 'Wombat_Ledger' ],
		] + parent::node_schema();
	}
}

<?php
/**
 * A node declaring an owned Table but no `owned_table()`, for pinning the
 * base hook's refusal.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Wombat_Bare_Table_Patron_Node extends \Newspack_Nodes\Node {
	/**
	 * A palette class declaring a `tally` Table it gives no arguments.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category' => 'Storage',
			'owns'     => [ 'tally' => 'Table' ],
		] + parent::node_schema();
	}
}

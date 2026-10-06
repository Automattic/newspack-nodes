<?php
/**
 * A node owning a Table, for pinning that the analyzer declares an owned
 * Table from the owner's own declaration rather than from a class it knows.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Fixtures;

\defined( 'ABSPATH' ) || exit;

class Wombat_Table_Patron_Node extends \Newspack_Nodes\Node {
	/**
	 * The `tally` Table's arguments: namespace the owner, TTL its first token,
	 * backend its second.
	 *
	 * @param string       $suffix    The owned Table's suffix.
	 * @param string       $owner     The owner's name.
	 * @param list<string> $arguments The owner's `make_node` arguments.
	 * @return array{namespace: string, ttl: string, backend: string}
	 */
	public static function owned_table( string $suffix, string $owner, array $arguments ): array {
		return [
			'namespace' => "{$owner}-{$suffix}",
			'ttl'       => $arguments[0] ?? '',
			'backend'   => $arguments[1] ?? '',
		];
	}

	/**
	 * A palette class declaring a `tally` Table.
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

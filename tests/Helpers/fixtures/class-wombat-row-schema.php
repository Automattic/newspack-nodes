<?php
/**
 * A Row_Schema of three tables, for pinning Sqlite_Arm's row tables: an
 * autoincrement name table with an FTS shadow, kept while a visit names it;
 * a keyed visit log retained by bucket; a tally folded by sum and max; and
 * a log of 300-second slot ids retained for 24 slots.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests;

\defined( 'ABSPATH' ) || exit;

final class Wombat_Row_Schema implements \Newspack_Nodes\Row_Schema {
	public static function version(): int {
		return 7;
	}

	public static function tables(): array {
		return [
			'burrows' => [
				'columns'       => [
					'id'   => 'INTEGER',
					'name' => 'TEXT NOT NULL',
				],
				'key'           => [ 'name' ],
				'autoincrement' => 'id',
				'retained_by'   => [ [ 'visits', 'burrow_id', 'id' ] ],
				'fts'           => [ 'name' ],
			],
			'visits'  => [
				'columns' => [
					'rid'       => 'TEXT NOT NULL',
					'bucket'    => 'INTEGER NOT NULL',
					'burrow_id' => 'INTEGER NOT NULL',
					'ms'        => 'REAL',
				],
				'key'     => [ 'rid' ],
				'indexes' => [
					'visits_bucket' => [ 'bucket' ],
					'visits_burrow' => [ 'burrow_id' ],
				],
				'retain'  => [ 'bucket', 3600, 1 ],
			],
			'tallies' => [
				'columns' => [
					'bucket' => 'INTEGER NOT NULL',
					'kind'   => 'TEXT NOT NULL',
					'n'      => 'INTEGER NOT NULL',
					'peak'   => 'REAL NOT NULL',
				],
				'key'     => [ 'bucket', 'kind' ],
				'add'     => [
					'n'    => 'sum',
					'peak' => 'max',
				],
				'retain'  => [ 'bucket', 3600, 1 ],
			],
			'slots'   => [
				'columns' => [
					'slot' => 'INTEGER NOT NULL',
					'kind' => 'TEXT NOT NULL',
					'n'    => 'INTEGER NOT NULL',
				],
				'key'     => [ 'slot', 'kind' ],
				'retain'  => [ 'slot', 24, 300 ],
			],
		];
	}
}

<?php
/**
 * Row_Schema: the declared tables a SQLite Table file holds beside `kv`.
 *
 * A schema names its tables, each one's columns in row order, the key its
 * `ignore` and `add` ops resolve conflicts on, the columns an `add` folds,
 * its indexes, its retention, and an FTS5 shadow over chosen columns.
 * `Sqlite_Arm` declares the tables at open and stamps the file's
 * `user_version` with `version()`; a file stamped with another version is
 * discarded, so a shape change bumps the version and starts a new file.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

interface Row_Schema {

	/**
	 * SQLite user_version of the declared shape; another version is discarded at open.
	 *
	 * @api Read by the node that opens a schema's files.
	 */
	public static function version(): int;

	/**
	 * The declared tables, keyed by name. `columns` lists each column's SQLite
	 * type in row order, `INTEGER`, `REAL`, `TEXT` or `BLOB` with an optional
	 * ` NOT NULL`. `key` is the UNIQUE key an `ignore` and an `add` conflict
	 * on. `add` names the columns an `add` folds on conflict, by `sum` or
	 * `max`. `retain` is `[ column, window, seconds per unit ]`: a row whose
	 * column is below `floor( now / unit ) − window` purges. `retained_by` is
	 * `[ table, its column, own column ]`: rows released when retention
	 * purges the rows that name them, each deleted once no row of that table
	 * names it. Every names row is written in the batch of a row naming it,
	 * so retention is the only way one is orphaned, and a row orphaned any
	 * other way is never examined. `autoincrement` is the INTEGER PRIMARY KEY column an `ignore`
	 * hands back. `fts` lists the columns an FTS5 shadow, `{table}_fts`,
	 * indexes, keyed by the `autoincrement` column.
	 *
	 * @return array<string, array{
	 *   columns: array<string,string>,
	 *   key?: list<string>,
	 *   add?: array<string,'sum'|'max'>,
	 *   indexes?: array<string,list<string>>,
	 *   retain?: array{0:string,1:int,2:int},
	 *   retained_by?: array{0:string,1:string,2:string},
	 *   autoincrement?: string,
	 *   fts?: list<string>
	 * }>
	 * @api Read by the node that opens a schema's files.
	 */
	public static function tables(): array;
}

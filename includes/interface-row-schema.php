<?php
/**
 * Row_Schema: the declared tables a SQLite Table file holds beside `kv`.
 *
 * A schema names its tables, each one's columns in row order, the key its
 * `ignore`, `add` and `set` ops resolve conflicts on, the columns an `add` folds,
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
	 * ` NOT NULL`. `key` is the UNIQUE key an `ignore`, an `add` and a `set`
	 * conflict on. `add` names the columns an `add` folds on conflict, by
	 * `sum`, `max` or `min`; `max` and `min` let a null displace nothing. A
	 * `set` replaces every column but the key and an `autoincrement` id, so
	 * it needs a `key` and a column outside both. `retain` is `[ column, window, seconds per unit ]`: a row
	 * whose column is below `floor( now / unit ) − window` purges. `retained_by` is
	 * a list of `[ table, its column, own column ]` references, where its
	 * column leads an index or the key there and the own column is this
	 * table's `autoincrement` column or one-column key: a row is released
	 * when a purge deletes rows naming it, and deleted once no row of any
	 * table it lists names it. A released row's own deletion releases the
	 * rows it named in turn, so a release cascades down a chain of
	 * references, and a chain may not return to a table on it. Every names
	 * row is written in the batch of a row naming it, so a purge is the only
	 * way one is orphaned, and a row orphaned any other way is never
	 * examined. `autoincrement` is the INTEGER PRIMARY KEY column an
	 * `ignore` hands back. `fts` lists the columns an FTS5 shadow,
	 * `{table}_fts`, indexes, keyed by the `autoincrement` column; insert,
	 * update and delete triggers keep it in step, a `set` included. `keep` is
	 * `true` alone: the table purges no row, so nothing retains it and it
	 * releases nothing, and it stands beside no `retain` or `retained_by`,
	 * nor may another table be `retained_by` it. Its disk grows without bound.
	 *
	 * @return array<string, array{
	 *   columns: array<string,string>,
	 *   key?: list<string>,
	 *   add?: array<string,'sum'|'max'|'min'>,
	 *   indexes?: array<string,list<string>>,
	 *   retain?: array{0:string,1:int,2:int},
	 *   retained_by?: list<array{0:string,1:string,2:string}>,
	 *   keep?: bool,
	 *   autoincrement?: string,
	 *   fts?: list<string>
	 * }>
	 * @api Read by the node that opens a schema's files.
	 */
	public static function tables(): array;
}

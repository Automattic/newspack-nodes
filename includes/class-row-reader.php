<?php
/**
 * Row_Reader: one read across a Row_Table's partitions.
 *
 * `Row_Table_Node::read()` hands one to its closure: a query-only
 * connection with every partition file that exists attached read-only as
 * `p{N}`, and the aliases it attached, so a query names only those. The SQL
 * is the caller's own fixed vocabulary; every value binds.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A query-only connection over the attached partition files.
 */
final class Row_Reader {

	/**
	 * Hold the connection `read()` opened and the aliases it attached.
	 *
	 * @param \PDO         $db      The query-only connection.
	 * @param list<string> $aliases Each attached file's schema name, `p{N}`, in partition order.
	 */
	public function __construct( private readonly \PDO $db, private readonly array $aliases ) {
	}

	/**
	 * Run one statement and answer its rows positionally. An int binds as an
	 * INTEGER, a null as NULL, anything else as TEXT, so a `LIMIT ?` or a
	 * comparison against an INTEGER column reads as written.
	 *
	 * @api The row tables' read path, for a verb answering from them.
	 * @param string                 $sql   The statement, naming `aliases()`.
	 * @param list<scalar|null>      $binds One value per `?`, in order.
	 * @return list<list<mixed>>
	 * @throws \PDOException When SQLite refuses the statement.
	 */
	public function rows( string $sql, array $binds ): array {
		$statement = $this->db->prepare( $sql );
		foreach ( $binds as $i => $value ) {
			$statement->bindValue( $i + 1, $value, match ( true ) {
				\is_int( $value ) => \PDO::PARAM_INT,
				null === $value   => \PDO::PARAM_NULL,
				default           => \PDO::PARAM_STR,
			} );
		}
		$statement->execute();
		return \array_values( \array_map( static fn ( mixed $row ): array => \array_values( Core::arr( $row ) ), $statement->fetchAll( \PDO::FETCH_NUM ) ) );
	}

	/**
	 * The schema names of the attached files, `p{N}`, in partition order;
	 * none when no partition has written a file.
	 *
	 * @api The row tables' read path, for a verb answering from them.
	 * @return list<string>
	 */
	public function aliases(): array {
		return $this->aliases;
	}
}

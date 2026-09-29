<?php
namespace Newspack_Nodes\Tests\Helpers;

/**
 * A `$wpdb` over in-memory SQLite for the wpdb arm's contract. It rewrites
 * only the MySQL forms Wpdb_Arm emits, so the arm's semantics run here and
 * MariaDB's dialect runs in the container smoke.
 *
 * `$deny` maps a substring to an error message: any statement containing the
 * substring fails with that message, as a refused or broken query would.
 * `$before` maps a substring to a closure run just before such a statement,
 * which is how a test puts a concurrent writer between a read and a write.
 * `$canned` maps a substring to the result rows such a statement answers.
 */
final class Sqlite_Wpdb extends \wpdb {
	public string $last_error  = '';
	public int $rows_affected  = 0;

	/** What `SELECT @@max_allowed_packet` answers. */
	public int $max_allowed_packet = 67108864;

	/** @var array<string,string> Substring => error message. */
	public array $deny = [];

	/** @var array<string,\Closure(): void> Substring => run before the statement. */
	public array $before = [];

	/** @var array<string,list<array<string,mixed>>> Substring => result rows. */
	public array $canned = [];

	/** @var list<string> Every statement the arm sent, as sent. */
	public array $sent = [];

	private \PDO $db;

	public function __construct() {
		$this->db = new \PDO( 'sqlite::memory:', null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
	}

	public function prepare( string $query, mixed ...$args ): string {
		$at = 0;
		return (string) \preg_replace_callback(
			'/%%|%[sdi]/',
			function ( array $m ) use ( $args, &$at ): string {
				if ( '%%' === $m[0] ) {
					return '%';
				}
				$arg = $args[ $at++ ] ?? '';
				return match ( $m[0] ) {
					'%d'    => (string) (int) $arg,
					'%i'    => '`' . \str_replace( '`', '``', (string) $arg ) . '`',
					default => (string) $this->db->quote( (string) $arg ),
				};
			},
			$query
		);
	}

	public function get_var( string $prepared ): ?string {
		if ( \str_contains( $prepared, '@@max_allowed_packet' ) ) {
			return $this->admit( $prepared ) ? (string) $this->max_allowed_packet : null;
		}
		return parent::get_var( $prepared );
	}

	public function query( string $query ): int|bool {
		if ( ! $this->admit( $query ) ) {
			return false;
		}
		if ( \str_starts_with( $query, 'CREATE TABLE' ) ) {
			$query = (string) \preg_replace( [ '/VARBINARY\(\d+\)|LONGBLOB|INT UNSIGNED/', '/,\s*KEY \w+ \( [^)]* \)/' ], [ 'BLOB', '' ], $query );
		}
		try {
			$this->rows_affected = (int) $this->db->exec( self::sqlite( $query ) );
			return $this->rows_affected;
		} catch ( \PDOException $e ) {
			$this->last_error = $e->getMessage();
			return false;
		}
	}

	/** @return list<array<string,mixed>> */
	public function get_results( string $query, string $output = 'OBJECT' ): array {
		if ( ! $this->admit( $query ) ) {
			return [];
		}
		foreach ( $this->canned as $needle => $rows ) {
			if ( \str_contains( $query, $needle ) ) {
				return $rows;
			}
		}
		try {
			return $this->db->query( self::sqlite( $query ) )->fetchAll( \PDO::FETCH_ASSOC );
		} catch ( \PDOException $e ) {
			$this->last_error = $e->getMessage();
			return [];
		}
	}

	/** Record a statement, run its `$before`, and refuse it where `$deny` names it. */
	private function admit( string $query ): bool {
		$this->sent[]     = $query;
		$this->last_error = '';
		foreach ( $this->before as $needle => $run ) {
			if ( \str_contains( $query, $needle ) ) {
				unset( $this->before[ $needle ] );
				$run();
			}
		}
		foreach ( $this->deny as $needle => $error ) {
			if ( \str_contains( $query, $needle ) ) {
				$this->last_error = $error;
				return false;
			}
		}
		return true;
	}

	private static function sqlite( string $sql ): string {
		$sql = \str_replace( 'INSERT IGNORE', 'INSERT OR IGNORE', $sql );
		$sql = (string) \preg_replace( '/ON DUPLICATE KEY UPDATE .*$/s', 'ON CONFLICT DO UPDATE SET `value` = excluded.`value`, expires = excluded.expires', $sql );
		$sql = (string) \preg_replace( '/^OPTIMIZE TABLE .*$/s', 'VACUUM', $sql );
		return (string) \preg_replace( '/^DELETE FROM (`[^`]+`) WHERE (.*) LIMIT (\d+)$/s', 'DELETE FROM $1 WHERE rowid IN ( SELECT rowid FROM $1 WHERE $2 LIMIT $3 )', $sql );
	}
}

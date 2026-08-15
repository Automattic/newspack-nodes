<?php
/**
 * Sessions: the durable DIRECTORY of command sessions this site has issued.
 *
 * The mirror of Vault. Vault stores credentials for connections this site
 * makes OUT; this records the ones it hands to callers coming IN — an agent's
 * MCP client, a script on someone's laptop — so an operator can see what is
 * connected and revoke it.
 *
 * `Command_Auth::store_session()` writes the key into `Cache_Backend`, and
 * cache stores do not enumerate, so nothing can list what exists. An option
 * holds the directory and the CACHE stays the authority on liveness: same
 * pointer-versus-lease split as SSE_Slot_Pool, for the same reason. A row
 * whose lease is gone is reported dead rather than deleted, so a revoked or
 * expired session is visible until it is pruned.
 *
 * The signing key is never written here. It cannot be hashed either —
 * verification recomputes an HMAC, so the key must stay recoverable — which is
 * exactly the argument for short TTLs over long-lived tokens.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Sessions {

	/** Directory option. Non-autoloaded: only the Sessions tab and revocation read it. */
	public const OPTION = 'newspack_nodes_sessions';

	/**
	 * Directory cap. Rows are pruned by expiry first, so this only bites when
	 * something mints faster than sessions expire — in which case the oldest
	 * rows are the least interesting.
	 */
	public const MAX_ROWS = 50;

	/** Longest label the directory keeps, so a listing can't be used as storage. */
	public const MAX_LABEL = 64;

	/**
	 * Record an issued session. Prunes expired rows first, so the directory
	 * stays bounded without a sweep of its own.
	 *
	 * Read-modify-write on one option, deliberately un-serialized: two mints in
	 * the same instant can lose a row, and the cost of that is a live session
	 * missing from the tab, not a broken one. A claim protocol here would buy
	 * an operator listing what the SSE slot pool needs for correctness.
	 */
	public static function record( string $handle, string $scope, string $label, int $ttl ): void {
		$now  = \time();
		$rows = self::prune( self::rows(), $now );

		$rows[ $handle ] = [
			'label'   => \substr( \sanitize_text_field( $label ), 0, self::MAX_LABEL ),
			'scope'   => $scope,
			'created' => $now,
			'expires' => $now + $ttl,
		];

		// Oldest first, so the cap drops the least interesting rows.
		if ( \count( $rows ) > self::MAX_ROWS ) {
			\uasort( $rows, static fn ( $a, $b ) => Core::as_int( $a['created'] ) <=> Core::as_int( $b['created'] ) );
			$rows = \array_slice( $rows, \count( $rows ) - self::MAX_ROWS, null, true );
		}

		\update_option( self::OPTION, $rows, false );
	}

	/**
	 * Revoke a session: drop the lease FIRST, so a failure to write the option
	 * leaves a listed-but-dead row rather than an unlisted live key.
	 */
	public static function forget( string $handle ): void {
		Command_Auth::revoke_session( $handle );
		$rows = self::rows();
		if ( ! isset( $rows[ $handle ] ) ) {
			return;
		}
		unset( $rows[ $handle ] );
		\update_option( self::OPTION, $rows, false );
	}

	/**
	 * The directory, newest first, each row carrying `live` — whether its key
	 * still resolves. Never carries the key itself.
	 *
	 * @return array<string,array{label:string,scope:string,created:int,expires:int,live:bool}>
	 */
	public static function all(): array {
		$now  = \time();
		$rows = self::prune( self::rows(), $now );
		\uasort( $rows, static fn ( $a, $b ) => Core::as_int( $b['created'] ) <=> Core::as_int( $a['created'] ) );

		// ONE cache round-trip for the whole directory, not one per row.
		$live = Command_Auth::live_handles( \array_map( 'strval', \array_keys( $rows ) ) );

		$out = [];
		foreach ( $rows as $handle => $row ) {
			$handle = (string) $handle;
			$scope  = Core::as_string( $row['scope'] ?? null, '' );
			$out[ $handle ] = [
				'label'   => Core::as_string( $row['label'] ?? '' ),
				'scope'   => '' === $scope ? Capabilities::MANAGE : $scope,
				'created' => Core::as_int( $row['created'] ?? 0 ),
				'expires' => Core::as_int( $row['expires'] ?? 0 ),
				'live'    => isset( $live[ $handle ] ),
			];
		}
		return $out;
	}

	/**
	 * Raw directory rows, or [] when the option holds anything else.
	 *
	 * @return array<array-key,array<array-key,mixed>>
	 */
	private static function rows(): array {
		$stored = \get_option( self::OPTION, [] );
		if ( ! \is_array( $stored ) ) {
			return [];
		}
		return \array_filter( $stored, '\is_array' );
	}

	/**
	 * Drop rows whose expiry has passed. Takes and returns the set rather than
	 * writing, so `record()` performs ONE option write for prune + insert.
	 *
	 * @param array<array-key,array<array-key,mixed>> $rows Directory rows.
	 * @return array<array-key,array<array-key,mixed>>
	 */
	private static function prune( array $rows, int $now ): array {
		return \array_filter( $rows, static fn ( $row ) => Core::as_int( $row['expires'] ?? 0 ) > $now );
	}
}

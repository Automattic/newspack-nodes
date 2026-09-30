<?php
/**
 * Sessions: the durable DIRECTORY of command sessions this site has issued.
 *
 * The mirror of Vault. Vault stores credentials for connections this site
 * makes OUT; this records the ones it hands to callers coming IN — an agent's
 * MCP client, a script on someone's laptop — so an operator can see what is
 * connected and revoke it.
 *
 * `Command_Auth::mint_session()` writes the key into the durable session
 * store, read by handle alone. An option holds the directory, labelled
 * sessions only, and the STORE stays the authority on liveness: the
 * pointer-versus-lease split SSE_Slot_Pool makes. A row whose store row is
 * gone is reported dead rather than deleted, so a revoked session stays on
 * the tab until its stated expiry passes.
 *
 * The signing key is never written here. It cannot be hashed either —
 * verification recomputes an HMAC, so the key must stay recoverable — which is
 * exactly the argument for short TTLs over long-lived tokens.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static store for the directory: one option, no instance state, so a web
 * request, a worker or WP-CLI reads it without wiring a node.
 */
class Sessions {

	/** Directory option. Non-autoloaded: only a mint, a revoke or the Sessions tab reads it. */
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
	 * missing from the tab, not a broken one. The SSE slot pool needs a claim
	 * protocol because ownership rides on it; an operator listing does not.
	 *
	 * @param string $handle Session handle: the directory key, and the key of its store row.
	 * @param string $scope  Capability ceiling the session carries, one of `Capabilities::READ|TUNE|MANAGE`.
	 * @param string $label  Operator's name for the session. An empty label records nothing.
	 * @param int    $ttl    Lifetime in seconds, counted from now.
	 */
	public static function record( string $handle, string $scope, string $label, int $ttl ): void {
		// @longform An unlabelled session is an automatic `/auth` mint, several
		// per dashboard load. Listing them buries the ones an operator issued
		// on purpose and, at MAX_ROWS, evicts them — a directory that cannot
		// be acted on. The session still works; it is just not listed.
		if ( '' === \trim( $label ) ) {
			return;
		}
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
	 * Revoke a session: drop the store row FIRST, so a failure to write the
	 * option leaves a listed-but-dead row rather than an unlisted live key. A
	 * store that did not answer leaves the row too, because the key may still
	 * verify.
	 *
	 * @param string $handle Session handle. A handle absent from the directory still has its store row dropped.
	 * @return bool|null Whether anything was revoked — the store held a row, or
	 *                   the directory did — or null when the store did not answer.
	 * @throws Session_Store_Unavailable When the store will not open.
	 */
	public static function forget( string $handle ): ?bool {
		$dropped = Command_Auth::revoke_session( $handle );
		if ( null === $dropped ) {
			return null;
		}
		$rows = self::rows();
		if ( ! isset( $rows[ $handle ] ) ) {
			return $dropped;
		}
		unset( $rows[ $handle ] );
		\update_option( self::OPTION, $rows, false );
		return true;
	}

	/**
	 * The handles whose directory row carries $label, newest first — what an
	 * operator who typed a label where a handle belongs meant to name.
	 *
	 * @param string $label Label to match exactly.
	 * @return list<string>
	 */
	public static function handles_labelled( string $label ): array {
		$handles = [];
		foreach ( self::all() as $handle => $row ) {
			if ( $row['label'] === $label ) {
				$handles[] = $handle;
			}
		}
		return $handles;
	}

	/**
	 * The directory, newest first, each row carrying `live` — whether its key
	 * still resolves — and `state`, which says WHY when it does not. Never
	 * carries the key itself.
	 *
	 * Expired rows leave the LISTING only; the option keeps them until the next
	 * `record()` rewrites it, so reading the tab writes nothing. A row stored
	 * without a scope lists as `manage`, so the listing never understates what
	 * a key that still resolves can do.
	 *
	 * @return array<string,array{label:string,scope:string,created:int,expires:int,live:bool,state:string}>
	 */
	public static function all(): array {
		$now  = \time();
		$rows = self::prune( self::rows(), $now );
		\uasort( $rows, static fn ( $a, $b ) => Core::as_int( $b['created'] ) <=> Core::as_int( $a['created'] ) );

		// ONE store read for the whole directory, not one per row.
		$live = Command_Auth::live_handles( \array_map( 'strval', \array_keys( $rows ) ) );

		$out = [];
		foreach ( $rows as $handle => $row ) {
			$handle = (string) $handle;
			$scope  = Core::as_string( $row['scope'] ?? null, '' );
			$expires = Core::as_int( $row['expires'] ?? 0 );
			$out[ $handle ] = [
				'label'   => Core::as_string( $row['label'] ?? '' ),
				'scope'   => '' === $scope ? Capabilities::MANAGE : $scope,
				'created' => Core::as_int( $row['created'] ?? 0 ),
				'expires' => $expires,
				'live'    => isset( $live[ $handle ] ),
				'state'   => self::state( isset( $live[ $handle ] ) ),
			];
		}
		return $out;
	}

	/**
	 * What a row's store row says about it, in one word.
	 *
	 * `all()` drops every row whose stated expiry has passed before it lists, so
	 * a listed row with no store row lost it EARLY. Something took it:
	 * `forget()`, or `wp nodes tables flush nodes-sessions`, which deletes every
	 * session. Neither is expiry, and naming it "expired" sends an operator to
	 * audit TTLs with hours left on them. That is why `live` alone is not
	 * enough to report.
	 *
	 * @param bool $live Whether the key still resolves.
	 * @return string `live` or `revoked`.
	 */
	private static function state( bool $live ): string {
		return $live ? 'live' : 'revoked';
	}

	/**
	 * Raw directory rows, with anything that is not an array dropped at both
	 * levels, so every caller can index a row without checking it first.
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
	 * @param int                                     $now  Unix timestamp to measure expiry against.
	 * @return array<array-key,array<array-key,mixed>>
	 */
	private static function prune( array $rows, int $now ): array {
		return \array_filter( $rows, static fn ( $row ) => Core::as_int( $row['expires'] ?? 0 ) > $now );
	}
}

<?php
/**
 * Memcache_CLI_Command: `wp nodes memcache` — `get` reads a cache entry by
 * its LOGICAL name, letting the substrate resolve the scope; `flush` rotates
 * the install's salt, which orphans every Newspack plugin's keys at once.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Read one cache entry, or flush every Newspack plugin's cached values.
 *
 * Registered as the `nodes memcache` group, so each public method is a
 * subcommand; a public instance method added here would list as one too.
 *
 * ## EXAMPLES
 *
 *     wp nodes memcache get table:prices:sku-9
 *     wp nodes memcache flush
 */
class Memcache_CLI_Command {

	/**
	 * Rotate the install's cache salt — THE flush, and the CLI half of the
	 * admin's "Flush Caches" button.
	 *
	 * One rotation orphans every Newspack plugin's cached values at once and
	 * touches no co-tenant install sharing the memcached. Plugins deliberately
	 * keep no salt of their own: with three independent rotations, flushing one
	 * leaves the other two serving stale values.
	 *
	 * The rotation asks every live worker to restart, because the scope is
	 * memoized per process and a live worker keeps writing the OLD prefix until
	 * it respawns. That restart is best-effort: a failure only delays the new
	 * scope to the next spawn, so it is reported as a warning rather than
	 * failing the flush. A rotation that never moved the salt fails it.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes memcache flush
	 *
	 * @api WP-CLI subcommand `wp nodes memcache flush` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param list<string>        $args       Unused.
	 * @param array<string,mixed> $assoc_args Unused.
	 * @throws \Throwable What a rotation that never moved the salt threw.
	 */
	public function flush( array $args, array $assoc_args ): void {
		$before    = Cache_Backend::salt();
		$restarted = '; every live worker was asked to restart';
		try {
			Cache_Backend::rotate_salt();
		} catch ( \Throwable $e ) {
			if ( Cache_Backend::salt() === $before ) {
				throw $e;
			}
			$restarted = '';
			\WP_CLI::warning( 'Workers were not asked to restart: ' . $e->getMessage() . ' — the new scope takes effect on their next spawn.' );
		}

		// @longform Sessions are named because the operator running this may be
		// holding one: the salt takes their leases like any other key, and an
		// MCP client's session going with a deploy reads as a 401 nobody
		// connects to the flush.
		\WP_CLI::success(
			"Cache salt rotated{$restarted}; every Newspack plugin key on this install is orphaned, "
			. 'including every issued session — reissue any you were using.'
		);
	}

	/**
	 * Read one cache entry by logical name.
	 *
	 * Every substrate key is `newspack_nodes:{version}:{scope}:{logical}`, so a
	 * logical name plus a scope is enough to rebuild the address — you never
	 * type the version or the site hash. `--key` prints the resolved address
	 * without reading, which is what you want when comparing two installs that
	 * share a memcached.
	 *
	 * ## OPTIONS
	 *
	 * <logical>
	 * : Logical name, as the writing surface spells it — e.g. `table:prices:sku-9`,
	 *   `job-batch:import-7719`, `job-uniq:sync:daily`, `cmd-nonce:<nonce>`.
	 *
	 * [--host]
	 * : Resolve in the per-MACHINE scope instead of the per-install one. SSE
	 *   connection slots are the only surface there: `sse:{slot}` holds the owner
	 *   token, and `sse:{slot}:lease:{owner}` the identity it was issued to.
	 *
	 * [--key]
	 * : Print the resolved key and exit without reading.
	 *
	 * [--porcelain]
	 * : Print the raw value only, with no key line — for piping into `jq`.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes memcache get table:prices:sku-9
	 *     wp nodes memcache get --key job-batch:import-7719
	 *     wp nodes memcache get --host sse:0
	 *
	 * @api WP-CLI subcommand `wp nodes memcache get` — invoked by WP-CLI via reflection, not called in PHP.
	 * @param list<string>        $args       Positional: the logical name.
	 * @param array<string,mixed> $assoc_args Flags; WP-CLI passes true for a bare flag.
	 */
	public function get( array $args, array $assoc_args = [] ): void {
		$logical = Core::as_string( $args[0] ?? '', '' );
		if ( '' === $logical ) {
			\WP_CLI::error( 'a logical name is required' );
		}

		$key = isset( $assoc_args['host'] )
			? Cache_Backend::host_key( $logical )
			: Cache_Backend::site_key( $logical );

		if ( isset( $assoc_args['key'] ) ) {
			\WP_CLI::line( $key );
			return;
		}

		$backend = Cache_Backend::shared_first();
		if ( null === $backend ) {
			// error() exits, but the analyser cannot know that.
			\WP_CLI::error( 'no cache backend: neither memcached nor APCu is available' );
			return;
		}

		$read = $backend->read( $key );
		// A confirmed miss and a read error are different answers; say which.
		if ( Cache_Backend::READ_ERROR === $read['status'] ) {
			\WP_CLI::error( 'backend read error for ' . $key . ': ' . $backend->last_failure() );
		}
		if ( Cache_Backend::READ_MISS === $read['status'] ) {
			\WP_CLI::error( 'not found: ' . $key );
		}

		if ( ! isset( $assoc_args['porcelain'] ) ) {
			\WP_CLI::line( $key );
		}
		\WP_CLI::line( (string) \wp_json_encode( $read['value'], \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES ) );
	}
}

<?php
/**
 * Memcache_CLI_Command: `wp nodes memcache` — read a cache entry by its
 * LOGICAL name, letting the substrate resolve the scope.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Memcache_CLI_Command {

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
	 * : Resolve in the per-MACHINE scope instead of the per-install one. Only SSE
	 *   slots (`sse:{user}:{ip}:{slot}`) live there.
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
	 *     wp nodes memcache get --host sse:17:abc12345:0
	 *
	 * @param list<string>          $args       Positional: the logical name.
	 * @param array<string,string> $assoc_args Flags.
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
			\WP_CLI::error( 'backend read error for ' . $key );
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

<?php
/**
 * Topology_Loader — reads a TSL topology file and runs it through a Shell instance.
 *
 * `<partition>` is bound here via Core::$var['partition']. `<ns:key>` tokens
 * (e.g. `<config:foo>`) resolve through their namespace's registered resolver
 * — see Core::register_config_namespace() / Config::register_token_namespace().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Loader {

	/**
	 * Load `<name>.tsl`, bind `<partition>`, and execute every statement against $sink.
	 *
	 * `<ns:key>` tokens resolve through their namespace's registered resolver
	 * (Core::register_config_namespace); the loader installs no config itself.
	 *
	 * @param string $name      Topology name (no .tsl suffix).
	 * @param int    $partition Partition number for `<partition>`.
	 * @param Node   $sink      Where dispatched Messages flow.
	 * @throws \RuntimeException If the topology is unknown.
	 */
	public static function load(
		string $name,
		int $partition,
		Node $sink
	): void {
		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			throw new \RuntimeException(
				\esc_html( "Topology_Loader: unknown topology '$name' (not in registry)" )
			);
		}

		// Bind `<partition>`; `<ns:key>` tokens use registered resolvers.
		Core::$var['partition'] = (string) $partition;

		$shell = new Shell_Node();
		$shell->sink( $sink );
		// No boot console: TM_NOREPLY drops replies dead-ending on _output.
		$shell->want_reply( false );
		// A cyclic .tsl fails loud at boot; it must not half-build the graph.
		$shell->fatal_on_cycle( true );

		// Local-disk TSL only; remote-fetch phpcs rule doesn't apply.
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$shell->eval_script( (string) \file_get_contents( $path ) );
	}
}

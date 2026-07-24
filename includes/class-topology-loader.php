<?php
/**
 * Topology_Loader — reads a TSL topology file and runs it through a Shell instance.
 *
 * `<partition>` and `<topology>` are bound here via Core::$var. `<topology>` names
 * the FLEET: an offsetlog is a reader's cursor and the reader is the fleet, so two
 * processes tailing one log need two cursors. It lets two topologies declare
 * BYTE-IDENTICAL Consumer lines — so composing them with `include` dedupes to one
 * reader — while each standalone fleet still gets its own offsetlog.
 *
 * `<ns:key>` tokens
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
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \RuntimeException( "Topology_Loader: unknown topology '$name' (not in registry)" );
		}

		// Bind the partition + fleet tokens; ns:key use registered resolvers.
		Core::$var['partition'] = (string) $partition;
		Core::$var['topology']  = $name;

		$shell = new Shell_Node();
		$shell->sink( $sink );
		// No boot console: TM_NOREPLY drops replies dead-ending on _output.
		$shell->want_reply( false );
		// A cyclic .tsl fails loud at boot; it must not half-build the graph.
		$shell->fatal_errors( true );

		// Local-disk TSL only; remote-fetch phpcs rule doesn't apply.
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$shell->eval_script( (string) \file_get_contents( $path ) );
		// EOF inside an open quote/continuation fails loud (fatal_errors on).
		$shell->flush_pending();
	}
}

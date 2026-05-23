<?php
/**
 * Topology_Loader — reads a TSL topology file and runs it through a Shell instance.
 *
 * Predefined bindings populated before parsing: Core::$var['partition'] and Core::$config[...]
 * (referenced in the TSL as `<partition>` and `<config:foo>`).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Loader {

	/**
	 * Load `<name>.tsl`, install pre-defined Shell bindings, and execute every statement against $sink.
	 *
	 * @param string              $name      Topology name (no .tsl suffix).
	 * @param int                 $partition Partition number for `<partition>`.
	 * @param Node                $sink      Where dispatched Messages flow.
	 * @param array<string,mixed> $config    Map for `<config:foo>` lookups.
	 * @throws \RuntimeException If the topology is unknown.
	 */
	public static function load(
		string $name,
		int $partition,
		Node $sink,
		array $config = []
	): void {
		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			throw new \RuntimeException(
				\esc_html( "Topology_Loader: unknown topology '$name' (not in registry)" )
			);
		}

		// Pre-populate the global maps the Shell reads from for `<partition>` / `<config:foo>`.
		Core::$var['partition'] = (string) $partition;
		Core::$config           = $config;

		$shell = new Shell_Node();
		$shell->sink( $sink );

		// TSL file content is local-disk only — phpcs's remote-fetch rule doesn't apply.
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$shell->eval_script( (string) \file_get_contents( $path ) );
	}
}

<?php
/**
 * Topology_Loader — reads a TSL topology file and runs it through a
 * Shell instance. The Shell handles `<varname>` / `<config:foo>`
 * interpolation, `var name = value` frontmatter, statement splitting
 * on `;`/newline, and dispatching each resulting Message via the
 * provided sink.
 *
 * Predefined bindings populated before parsing:
 *   Core::$var['partition']   → integer partition number (string)
 *   Core::$config[...]        → entire $config arg, key-by-key
 *
 * The TSL refers to them as `<partition>` and `<config:foo>`.
 *
 * Anything else the topology needs (per-fleet metadata like
 * num_partitions / stale_timeout) is declared inline with `var`
 * frontmatter; supervisor-side metadata lookups read the same TSL
 * file via Topology_Registry::frontmatter() without executing it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Loader {

	/**
	 * Load `<name>.tsl`, install pre-defined Shell bindings, and
	 * execute every statement against $sink (typically a CI). Throws
	 * when the topology is unknown.
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

		// Pre-populate the global maps the Shell reads from. $var
		// holds the predefined `partition` binding; $config holds
		// the runtime config the topology refers to via
		// `<config:foo>`. Topology authors can override $var via
		// `var name = value` frontmatter (and any verb dispatched
		// during load can read/write it).
		Core::$var['partition'] = (string) $partition;
		Core::$config           = $config;

		$shell = new Shell();
		$shell->sink( $sink );

		// TSL file content is local-disk only — Topology_Registry
		// resolves to plugin or user dir paths. phpcs's remote-fetch
		// rule doesn't apply.
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$shell->eval_script( (string) \file_get_contents( $path ) );
	}
}

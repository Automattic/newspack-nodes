<?php
/**
 * Topology_Loader — reads a TSL topology file, substitutes
 * `{partition}` / `{config:foo}` tokens, and dispatches each
 * line through a CommandInterpreter::execute() to build the
 * node graph.
 *
 * TSL syntax mirrors the existing cli vocabulary:
 *   - blank lines + lines starting with `#` are skipped
 *   - every other line is a CI verb (`make_node`,
 *     `connect_node`, `cmd <path> <verb>`, …)
 *
 * Substitution rules applied before dispatch:
 *   `{partition}`     → integer partition number
 *   `{config:<key>}`  → $config[<key>] (string)
 *
 * Unknown substitution keys throw RuntimeException at load time
 * so misconfigured topologies fail loudly rather than leaving
 * the worker in a half-built state.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Loader {

	/**
	 * Load `<name>.tsl` and execute its verbs against $ci.
	 *
	 * @param string              $name      Topology name (no .tsl suffix).
	 * @param int                 $partition Partition number for {partition} substitution.
	 * @param CommandInterpreter  $ci        Interpreter to dispatch through.
	 * @param array<string,mixed> $config    Map for {config:foo} substitution.
	 * @throws \RuntimeException If the topology is unknown OR a substitution key is missing.
	 */
	public static function load(
		string $name,
		int $partition,
		CommandInterpreter $ci,
		array $config = []
	): void {
		$path = Topology_Registry::resolve( $name );
		if ( null === $path ) {
			throw new \RuntimeException(
				\esc_html( "Topology_Loader: unknown topology '$name' (not in registry)" )
			);
		}
		// TSL files are local-disk reads only — Topology_Registry::resolve
		// returns paths under the plugin dir or the operator's user_dir.
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents = (string) \file_get_contents( $path );
		foreach ( \explode( "\n", $contents ) as $raw ) {
			$line = \trim( $raw );
			if ( '' === $line || \str_starts_with( $line, '#' ) ) {
				continue;
			}
			$expanded = self::substitute( $line, $partition, $config );
			$ci->execute( $expanded );
		}
	}

	/**
	 * Token substitution. Throws on unknown {config:foo} keys; an
	 * unknown {partition} can't happen because the caller always
	 * passes an int.
	 *
	 * @param array<string,mixed> $config
	 */
	private static function substitute( string $line, int $partition, array $config ): string {
		$line = \str_replace( '{partition}', (string) $partition, $line );
		$line = (string) \preg_replace_callback(
			'/\{config:([A-Za-z0-9_]+)\}/',
			static function ( array $m ) use ( $config ): string {
				$key = $m[1];
				if ( ! \array_key_exists( $key, $config ) ) {
					throw new \RuntimeException(
						\esc_html( "Topology_Loader: unknown config key '$key' in TSL substitution" )
					);
				}
				return (string) $config[ $key ];
			},
			$line
		);
		return $line;
	}
}

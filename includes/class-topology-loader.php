<?php
/**
 * Topology_Loader — builds a worker's node graph from its `.tsl` topology file.
 *
 * The loader binds the two values a topology cannot know about itself, then
 * hands the file to a Shell: the partition and `<topology>` go into `Core::$var`,
 * while every `<ns:key>` token (`<config:logs_dir>`) resolves through its
 * namespace's registered resolver instead — see `Core::register_config_namespace()`
 * and `Config::register_token_namespace()`.
 *
 * `<topology>` names the FLEET. An offsetlog is a reader's cursor and the reader
 * is the fleet, so two processes tailing one log need two cursors. The token lets
 * two topologies declare BYTE-IDENTICAL Consumer lines — composing them with
 * `include` then collapses to a single reader — while each standalone fleet still
 * gets its own offsetlog.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The static entry point for topology loading.
 *
 * The Shell it builds lives only for the call. What survives is the graph the
 * statements registered in `Core`, which is why nothing here is an instance.
 */
class Topology_Loader {

	/**
	 * Load `<name>.tsl` and execute every statement against $sink.
	 *
	 * The partition and `<topology>` are bound into `Core::$var` before the file
	 * is evaluated: the Shell interpolates `<topology>`, and a node resolves
	 * `{partition}` in its marked arguments against the bound partition. The binding is
	 * process-global and outlives the call. A `<ns:key>` token takes no binding at
	 * all — it reaches the resolver its namespace registered at boot, so the
	 * loader installs no config of its own.
	 *
	 * @param string $name      Topology name, without the `.tsl` suffix.
	 * @param int    $partition Partition number a node resolves `{partition}` to.
	 * @param Node   $sink      Where the dispatched Messages flow — the worker's
	 *                          `_command_interpreter` in production.
	 * @throws \Throwable When the name is not in the registry; otherwise every
	 *                    line that failed — a refused statement, a command that
	 *                    threw or reached no node, a missing or cyclic include,
	 *                    an open quote at end of file — raised together after
	 *                    the last line ran.
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

		Core::$var['partition'] = (string) $partition;
		Core::$var['topology']  = $name;

		$shell = new Shell_Node();
		$shell->sink( $sink );
		// No boot console: TM_NOREPLY suppresses replies bound for _output.
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

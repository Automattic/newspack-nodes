<?php
/**
 * Cli_Command: WP-CLI command wrapper that exposes `wp nodes ls` and `wp nodes cli`.
 *
 * Registered via WP_CLI::add_command('nodes', ...) from the plugin bootstrap
 * when WP-CLI is available.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Cli_Command {

	private function base_dir(): string {
		return (string) \apply_filters( 'newspack_nodes/base_dir', '/tmp/newspack-nodes' );
	}

	/**
	 * List live workers.
	 *
	 * Reads `{base_dir}/locks/{type}.p{N}.lock.d/heartbeat` and reports each
	 * worker's age and freshness. Stale entries (heartbeat > 60s old) are flagged.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes ls
	 */
	public function ls( array $args, array $assoc_args ): void {
		$cli     = new Cli( $this->base_dir() );
		$workers = $cli->ls_workers();
		if ( empty( $workers ) ) {
			\WP_CLI::log( 'No workers running. base_dir=' . $this->base_dir() );
			return;
		}
		$now = \time();
		foreach ( $workers as $w ) {
			$age      = $w['heartbeat_at'] ? ( $now - $w['heartbeat_at'] ) . 's ago' : 'never';
			$flag     = $w['stale'] ? '[stale]' : '[live] ';
			$reader   = "{$w['type']}.p{$w['partition']}";
			\WP_CLI::log( \sprintf( '%s %-30s heartbeat %s', $flag, $reader, $age ) );
		}
	}

	/**
	 * Open an interactive REPL against a worker's IPC firehoses.
	 *
	 * ## OPTIONS
	 *
	 * [<reader>]
	 * : Reader id in the form {type}.p{N}, e.g. firehose-workers.p0.
	 * If omitted, opens a bare local Tachikoma standalone (no pivot).
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes cli
	 *     wp nodes cli firehose-workers.p0
	 */
	public function cli( array $args, array $assoc_args ): void {
		\WP_CLI::warning( 'REPL Shell/Dumper not yet implemented (deferred plan-D work).' );

		$cli = new Cli( $this->base_dir() );

		if ( empty( $args ) ) {
			\WP_CLI::log( 'Bare cli mode — would build local Router + CommandInterpreter + Responder + Dumper.' );
			\WP_CLI::log( 'Manual recipe: see .specs/2026-05-06-newspack-nodes-design.md "Admin REPL".' );
			return;
		}

		$reader_id = $args[0];
		try {
			$ipc = $cli->attach_to_worker( $reader_id );
		} catch ( \InvalidArgumentException $e ) {
			\WP_CLI::error( $e->getMessage() );
		}

		\WP_CLI::log( "Pivoted-cli mode for $reader_id" );
		\WP_CLI::log( "  input  partition: {$ipc['input']}" );
		\WP_CLI::log( "  output partition: {$ipc['output']}" );
		\WP_CLI::log( '(REPL loop not yet wired — would Tail output, write to input, run Shell parser.)' );
	}
}

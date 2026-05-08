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
	 * Open an interactive REPL.
	 *
	 * Bare mode (no <reader> arg): builds a local _router + _command_interpreter +
	 * _responder + _shell + _dumper graph; commands run against this process.
	 *
	 * Pivoted mode (<reader>=type.pN): also wires Partition cmd-out → worker input
	 * and Consumer reply-in → worker output, so commands cross the IPC boundary.
	 *
	 * Uses ext-readline if available; falls back to fgets() on STDIN otherwise.
	 *
	 * ## OPTIONS
	 *
	 * [<reader>]
	 * : Reader id in the form {type}.p{N}, e.g. firehose-workers.p0.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes cli
	 *     wp nodes cli firehose-workers.p0
	 */
	public function cli( array $args, array $assoc_args ): void {
		$cli = new Cli( $this->base_dir() );

		$pivoted = ! empty( $args );
		$ipc     = null;

		if ( $pivoted ) {
			$reader_id = $args[0];
			try {
				$ipc = $cli->attach_to_worker( $reader_id );
			} catch ( \InvalidArgumentException $e ) {
				\WP_CLI::error( $e->getMessage() );
				return;
			}
			\WP_CLI::log( "Pivoted-cli mode for $reader_id" );
			\WP_CLI::log( "  input  partition: {$ipc['input']}" );
			\WP_CLI::log( "  output partition: {$ipc['output']}" );
		} else {
			\WP_CLI::log( 'Bare cli mode (local nodes only).' );
		}

		[ $shell, $dumper ] = $this->build_repl_graph( $pivoted, $ipc );

		$this->run_repl( $shell, $dumper );
	}

	/**
	 * Build the REPL node graph and return [Shell, Dumper] for the loop driver.
	 *
	 * Layout (bare):
	 *   _shell → _command_interpreter → _router → _dumper
	 *                                          ↑
	 *                                       _responder (sink for shell-callback dispatch)
	 *
	 * Pivoted adds: cmd-out (Partition) writing to worker input,
	 *               reply-in (Consumer) reading from worker output.
	 *
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell,1:Dumper}
	 */
	private function build_repl_graph( bool $pivoted, ?array $ipc ): array {
		$router = new Router();
		$router->name( '_router' );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		$dumper = new Dumper();
		$dumper->name( '_dumper' );

		$responder = new Responder();
		$responder->name( '_responder' );
		$responder->sink( $dumper );

		// Router fans into Responder, which dispatches by ID.
		$router->sink( $responder );

		$shell = new Shell();
		$shell->name( '_shell' );
		$shell->sink( $ci ); // bare default — pivoted mode overrides per-message.

		$dumper->set_shell( $shell );
		$responder->set_shell( $shell );

		if ( $pivoted && $ipc !== null ) {
			// Pivoted: shell sends through cmd-out Partition (writing to worker input);
			// consumer reads worker output and feeds Responder.
			//
			// IPC topics are always single-partition (p0 layout). The reader id's
			// outer partition (e.g. .p3) is encoded in the topic dir; the Partition/
			// Consumer constructors always use partition=0 here, since they each
			// own a single-partition topic that lives at {topic-dir}/p0/.
			$offset_dir = "{$this->base_dir()}/offsets/cli-repl";

			$cmd_out = new Partition( $ipc['input'], 0 );
			$cmd_out->name( 'cmd-out' );
			$cmd_out->sink( $ci );
			$shell->sink( $cmd_out );

			// reply-in is a Consumer reading the worker's output partition,
			// feeding into the Responder for ID-correlation. Tests don't
			// exercise this; bare-mode covers the build path.
			$reply_in = new Consumer( $ipc['output'], 0, $offset_dir );
			$reply_in->name( 'reply-in' );
			$reply_in->sink( $responder );
		}

		return [ $shell, $dumper ];
	}

	/**
	 * Drive the REPL: read line, parse, fill, repeat. Exits on EOF / Ctrl-D.
	 *
	 * Uses ext-readline if available (history, line editing); falls back to
	 * raw fgets on STDIN. Prompt updates honor any prompt-intercept the
	 * Dumper has already applied to $shell->prompt.
	 */
	private function run_repl( Shell $shell, Dumper $dumper ): void {
		$has_readline = \function_exists( 'readline' );

		while ( true ) {
			Core::update_time();

			if ( $has_readline ) {
				$line = \readline( $shell->prompt );
				if ( $line === false ) {
					break;
				}
				if ( $line !== '' && \function_exists( 'readline_add_history' ) ) {
					\readline_add_history( $line );
				}
			} else {
				\fwrite( \STDOUT, $shell->prompt );
				$line = \fgets( \STDIN );
				if ( $line === false ) {
					break;
				}
				$line = \rtrim( $line, "\r\n" );
			}

			$msg = $shell->parse(
				$line,
				static function ( array $info ) use ( $dumper ): void {
					// Reconstitute a TM_COMMAND|TM_RESPONSE so Dumper unwraps the
					// Command struct (or TM_ERROR for errors). Payload field of
					// $info IS the message VALUE, which for command-responses is
					// the JSON-encoded {name, payload} struct.
					$response                  = Message::new_message();
					$response[ Message::FROM ] = (string) ( $info['from'] ?? '' );
					$value                     = (string) ( $info['payload'] ?? '' );

					if ( $info['error'] ) {
						$response[ Message::TYPE ]  = Message::TM_ERROR;
						$response[ Message::VALUE ] = $value;
						$dumper->fill( $response );
						return;
					}

					// Heuristic: if VALUE parses as JSON with a 'name' field,
					// treat it as a Command response so Dumper unwraps it.
					$decoded = \json_decode( $value, true );
					if ( \is_array( $decoded ) && isset( $decoded['name'] ) ) {
						$response[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
						$response[ Message::VALUE ] = $value;
					} else {
						$response[ Message::TYPE ]  = Message::TM_BYTESTREAM;
						$response[ Message::VALUE ] = $value;
					}
					$dumper->fill( $response );
				}
			);

			if ( $msg === null ) {
				continue;
			}
			$shell->fill( $msg );
		}

		\WP_CLI::log( '' ); // Trailing newline after EOF.
	}
}

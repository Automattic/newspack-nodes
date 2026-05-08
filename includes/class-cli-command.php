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

		[ $shell, $dumper, $reply_in ] = $this->build_repl_graph( $pivoted, $ipc );

		$this->run_repl( $shell, $dumper, $reply_in );
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
	/**
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell,1:Dumper,2:?Consumer}
	 */
	private function build_repl_graph( bool $pivoted, ?array $ipc ): array {
		$pid = (string) \getmypid();

		$router = new Router();
		$router->name( '_router' );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		$dumper = new Dumper();
		$dumper->name( '_dumper' );

		// Responder always sinks into Dumper. When it needs to send replies
		// path-routed (TM_PERSIST cancel/answer), it addresses _router via
		// Core::node('_router')->fill() instead of $this->sink — see
		// class-responder.php. Spec line 689 + user direction.
		$responder = new Responder();
		$responder->name( '_responder' );
		$responder->sink( $dumper );

		// Router fans into Responder for messages with TO=='' that fall
		// through (async broadcasts dispatched by Responder's ID match).
		$router->sink( $responder );

		$shell = new Shell();
		$shell->name( '_shell' );
		// Default shell.sink: pivoted overrides to cmd-out below; bare goes
		// straight to _command_interpreter (no IPC partitions).
		$shell->sink( $ci );

		$dumper->set_shell( $shell );
		$responder->set_shell( $shell );

		if ( $pivoted && $ipc !== null ) {
			// Pivoted: shell sends → pack-Callback → cmd-out (Partition,
			// writing JSON-packed lines to worker input). Worker round-trips,
			// writes its packed reply to its output Partition, which the cli's
			// reply-in Consumer reads → unpack-Callback → _router (which
			// dispatches by the unpacked message's TO, e.g. _responder/$pid).
			//
			// IPC topics are always single-partition (p0 layout). The reader
			// id's outer partition (e.g. .p3) is encoded in the topic dir; the
			// Partition/Consumer constructors here always use partition=0
			// since each owns a single-partition topic at {topic-dir}/p0/.
			$offset_dir = "{$this->base_dir()}/offsets/cli-repl.{$pid}";

			$cmd_out = new Partition( $ipc['input'], 0 );
			$cmd_out->allow_large_writes(); // packed messages can exceed 4KB on rich payloads.
			$cmd_out->name( 'cmd-out' );

			// Pack-Callback: takes any message Shell emits (TM_COMMAND etc.),
			// serializes via Message::packed(), wraps as TM_BYTESTREAM, and
			// fills cmd-out so the bytes hit disk. Spec line 670.
			$pack = new Callback( static function ( array $msg ) use ( $cmd_out ): void {
				$packed                          = Message::packed( $msg );
				$bytes                           = Message::new_message();
				$bytes[ Message::TYPE ]          = Message::TM_BYTESTREAM;
				$bytes[ Message::TIMESTAMP ]     = Core::$right_now;
				$bytes[ Message::VALUE ]         = $packed . "\n";
				$cmd_out->fill( $bytes );
			} );
			$pack->name( "cli-repl-pack.{$pid}" );
			$shell->sink( $pack );

			// reply-in: Consumer tailing the worker's output Partition. Each
			// poll emits TM_BYTESTREAM lines; the unpack-Callback reconstitutes
			// the original Message and routes it via _router (which dispatches
			// by TO=`_responder/$pid` → _responder → ID match → shell callback
			// → Dumper).
			$reply_in = new Consumer( $ipc['output'], 0, $offset_dir );
			$reply_in->name( 'reply-in' );

			$unpack = new Callback( static function ( array $msg ) use ( $router ): void {
				$value = (string) $msg[ Message::VALUE ];
				if ( '' === $value ) {
					return;
				}
				$unpacked = Message::unpacked( \rtrim( $value, "\n" ) );
				$router->fill( $unpacked );
			} );
			$unpack->name( "cli-repl-unpack.{$pid}" );
			$reply_in->sink( $unpack );
			$reply_in->set_timer( Consumer::POLL_INTERVAL_EOF_MS, true ); // bootstrap; fire() re-arms.
		}

		// Dumper TO filter: matches `_responder/$pid` (worker reply that didn't
		// have _responder peeled — bare mode + path-shorter pivot replies) and
		// `$pid` (worker reply that did have _responder peeled by _router). Empty
		// TO is always rendered (covers async broadcasts and the synthetic
		// TM_COMMAND|TM_RESPONSE the parse-callback feeds Dumper directly).
		// Multi-session: other clis' replies match a different $pid → drop.
		$dumper->set_to_filter( $pid );

		return [ $shell, $dumper, $pivoted ? $reply_in : null ];
	}

	/**
	 * Drive the REPL: read line, parse, fill, repeat. Exits on EOF / Ctrl-D.
	 *
	 * Uses ext-readline if available (history, line editing); falls back to
	 * raw fgets on STDIN. Prompt updates honor any prompt-intercept the
	 * Dumper has already applied to $shell->prompt.
	 */
	/**
	 * Drive the cli's pivoted reply-in Consumer for up to $deadline_ms ms.
	 * Polls in a tight loop; stops as soon as the round-trip flag flips OR the
	 * deadline expires. Used between command sends so the worker has time to
	 * respond before the next prompt. Bare mode skips this — local responses
	 * dispatch synchronously.
	 */
	private function drain_reply( ?Consumer $reply_in, int $deadline_ms = 5000 ): void {
		if ( $reply_in === null ) {
			return;
		}
		$deadline = \microtime( true ) + ( $deadline_ms / 1000.0 );
		while ( \microtime( true ) < $deadline ) {
			Core::update_time();
			$reply_in->poll();
			\usleep( 10_000 ); // 10ms — friendly to interactive feel.
		}
	}

	private function run_repl( Shell $shell, Dumper $dumper, ?Consumer $reply_in = null ): void {
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

			// Pivoted: poll the cli's reply-in for the worker's round-trip
			// response. Bare: $reply_in is null; this is a no-op.
			$this->drain_reply( $reply_in );
		}

		\WP_CLI::log( '' ); // Trailing newline after EOF.
	}
}

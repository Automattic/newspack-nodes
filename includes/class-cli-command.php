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
	/**
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell,1:Dumper}
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
		}

		// Dumper TO filter: matches `_responder/$pid` (worker reply with
		// `_responder` not yet peeled) and `$pid` (worker reply with
		// `_responder` already peeled by _router). Empty TO is always rendered
		// (async broadcasts). Multi-session: other clis' replies use a
		// different $pid and drop silently.
		$dumper->set_to_filter( $pid );

		return [ $shell, $dumper ];
	}

	/**
	 * Drive the REPL via the event loop. STDIN registers as a reader_node;
	 * EventFramework::drain selects on STDIN and fires Consumer/Tail timers
	 * (e.g. the pivoted-mode reply-in Consumer). When STDIN becomes readable,
	 * fgets() reads a line, Shell parses and fills it through the graph; the
	 * worker's response, when it arrives, propagates through reply-in →
	 * unpack → _router → _responder → shell-callback → Dumper without any
	 * synchronous "wait for reply" hack. EOF on STDIN exits the drain loop.
	 *
	 * Uses ext-readline when available for history/line-editing; otherwise
	 * stream_set_blocking(STDIN, false) and stream_select handle non-blocking
	 * line reads.
	 */
	private function run_repl( Shell $shell, Dumper $dumper ): void {
		$has_readline = \function_exists( 'readline' );

		// STDIN reader: a tiny anonymous-class Node-like wrapper that exposes
		// $stream and drain_fh() so EventFramework::register_reader_node can
		// drive it. drain_fh either uses readline (blocking — the read was
		// already select-gated) or fgets, then routes the line through Shell.
		$exit  = false;
		$stdin = new class( $shell, $dumper, $has_readline, $exit ) {
			public $stream;
			private Shell $shell;
			private Dumper $dumper;
			private bool $has_readline;
			private bool $prompt_displayed = false;

			public function __construct( Shell $shell, Dumper $dumper, bool $has_readline, bool &$exit ) {
				$this->stream       = \STDIN;
				$this->shell        = $shell;
				$this->dumper       = $dumper;
				$this->has_readline = $has_readline;
				$this->exit         = &$exit;
				if ( ! $has_readline ) {
					@\stream_set_blocking( $this->stream, false );
				}
			}

			public bool $exit;

			public function show_prompt(): void {
				if ( $this->has_readline ) {
					return; // readline owns prompt rendering itself.
				}
				if ( $this->prompt_displayed ) {
					return;
				}
				\fwrite( \STDOUT, $this->shell->prompt );
				$this->dumper->mark_prompt_displayed();
				$this->prompt_displayed = true;
			}

			public function drain_fh(): void {
				if ( $this->has_readline ) {
					$line = \readline( $this->shell->prompt );
					if ( $line === false ) {
						$this->exit = true;
						return;
					}
					if ( $line !== '' && \function_exists( 'readline_add_history' ) ) {
						\readline_add_history( $line );
					}
				} else {
					$line = \fgets( $this->stream );
					if ( $line === false ) {
						// fgets returns false on either EOF or no-data-available
						// (non-blocking). Distinguish via feof.
						if ( \feof( $this->stream ) ) {
							$this->exit = true;
						}
						return;
					}
					$line                   = \rtrim( $line, "\r\n" );
					$this->prompt_displayed = false;
				}

				$msg = $this->shell->parse( $line );
				if ( $msg !== null ) {
					$this->shell->fill( $msg );
				}
				$this->show_prompt();
			}
		};

		EventFramework::instance()->register_reader_node( $stdin );
		$stdin->show_prompt();

		EventFramework::instance()->drain( static fn () => ! $stdin->exit );

		EventFramework::instance()->unregister_reader_node( $stdin );
		\WP_CLI::log( '' ); // Trailing newline after EOF.
	}
}

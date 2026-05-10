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

		$interpreter = new CommandInterpreter();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( $router );

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

		// Real Tachikoma Shell3 nodes are anonymous (Shell3::name throws on
		// rename). Don't try to give it a name — `ls` filters by sink, so the
		// shell still appears as a sibling of _command_interpreter without
		// needing a registered name.
		$shell = new Shell();
		$shell->sink( $interpreter );

		// Prompt reflects the pivoted target so the user can tell which worker
		// they're attached to. Bare mode keeps the default `newspack-nodes>`.
		if ( $pivoted && null !== $ipc ) {
			$shell->prompt = "{$ipc['type']}.p{$ipc['partition']}> ";
		}

		$dumper->set_shell( $shell );
		// When the readline callback API is available, run_repl uses it; tell
		// the Dumper so its async-output path uses readline_on_new_line +
		// readline_redisplay instead of the manual ANSI cursor dance (which
		// leaves readline's internal line buffer out of sync).
		$dumper->set_readline_mode( \function_exists( 'readline_callback_handler_install' ) );

		if ( $pivoted && null !== $ipc ) {
			// Pivoted: shell → cmd-out (Partition auto-packs each emitted
			// Message via Message::packed → segment). reply-in (Consumer
			// auto-unpacks the worker's reply Partition → Message) → _router
			// (dispatches by TO=_responder/$pid → _responder → Dumper).
			// IPC topics are single-partition (p0); the outer partition number
			// (.p3) lives in the topic dir, so constructors use partition=0.

			$cmd_out = new Partition( $ipc['input'], 0 );
			$cmd_out->name( 'cmd-out' );
			$cmd_out->sink( $interpreter );
			// allow_large_writes wires Lock + heartbeat Timer keyed off the
			// Partition's name/sink, so they must be set first. Packed
			// command messages can exceed 4KB.
			$cmd_out->allow_large_writes();
			$shell->sink( $cmd_out );

			// reply-in is unnamed (no other node addresses it directly); its
			// Consumer poll emits unpacked Messages whose TO already encodes
			// the cli's $pid (worker's _router peeled `_repl` before writing).
			//
			// Empty offsetlog_base_dir (3rd arg) → Consumer skips the offsetlog
			// entirely. cli sessions are ephemeral; they tail-seek at startup
			// and have no need to durably resume a cursor.
			$reply_in = new Consumer( $ipc['output'], 0, '' );
			$reply_in->next_offset( 'end' );
			$reply_in->sink( $router );
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
	 * (e.g. the pivoted-mode reply-in Consumer).
	 *
	 * Mirrors real Tachikoma TTY.pm. With readline available:
	 *  - install_handler() calls readline_callback_handler_install(prompt, cb)
	 *    which renders the prompt immediately and arms a per-byte callback.
	 *  - drain_fh feeds one byte at a time via readline_callback_read_char();
	 *    when the user hits enter, the callback fires with the completed
	 *    line and we queue a Message. PHP auto-removes the handler after
	 *    each delivered line, so we re-install to render the next prompt.
	 *  - That's it — no blocking readline() that misses prompt-before-input.
	 *
	 * Without readline: stream_set_blocking(STDIN, false), fgets per ready
	 * chunk, manually print the prompt before the loop and after each line.
	 *
	 * EOF on STDIN exits the drain loop.
	 */
	private function run_repl( Shell $shell, Dumper $dumper ): void {
		$has_readline = \function_exists( 'readline_callback_handler_install' );

		$exit  = false;
		$stdin = new class( $shell, $dumper, $has_readline, $exit ) {
			public $stream;
			private Shell $shell;
			private Dumper $dumper;
			private bool $has_readline;
			private bool $prompt_displayed = false;
			/** @var array<int,string> Lines delivered by the readline callback, drained per drain_fh. */
			private array $queue = [];
			private bool $readline_eof = false;

			public function __construct( Shell $shell, Dumper $dumper, bool $has_readline, bool &$exit ) {
				$this->stream       = \STDIN;
				$this->shell        = $shell;
				$this->dumper       = $dumper;
				$this->has_readline = $has_readline;
				$this->exit         = &$exit;

				if ( $has_readline ) {
					$this->install_handler();
				} else {
					@\stream_set_blocking( $this->stream, false );
					$this->show_prompt_fallback();
				}
			}

			public bool $exit;

			/**
			 * (Re-)install the readline callback handler. PHP auto-removes the
			 * handler after each line is delivered, so we install once at
			 * startup and again after every processed line so the next prompt
			 * renders.
			 *
			 * Install with the REAL prompt so readline knows the prompt's
			 * width — that's what stops backspace from chewing back through
			 * the prompt characters once the buffer empties (readline tracks
			 * cursor as `prompt-end-col + buffer-point`, so an empty prompt
			 * places the buffer at col 0 and a redraw happily overwrites our
			 * manually-written prompt).
			 *
			 * The earlier reverse-search bug ("typing one char rendered
			 * `bck:`") came from calling `readline_redisplay()` after a
			 * non-empty-prompt install — NOT from the non-empty prompt
			 * itself. The Dumper's async path no longer calls redisplay; it
			 * just wipes the line, prints the async text, and rewrites the
			 * prompt to stdout. readline's internal prompt-width still
			 * matches what's on screen, so cursor math stays correct.
			 */
			private function install_handler(): void {
				\readline_callback_handler_install(
					$this->shell->prompt,
					function ( $line ): void {
						if ( null === $line ) {
							$this->readline_eof = true;
							return;
						}
						if ( '' !== $line && \function_exists( 'readline_add_history' ) ) {
							\readline_add_history( $line );
						}
						$this->queue[] = $line;
						// User's line was just consumed; the on-screen prompt is
						// no longer active. Clear the Dumper's flag so any
						// synchronous output during queue processing (e.g.,
						// bare-mode TM_PING bounce) writes plainly instead of
						// doing the async wipe-and-redisplay dance — that dance
						// would otherwise paint a duplicate prompt next to the
						// just-entered line. install_handler() below resets the
						// flag once the next prompt is on screen, so async
						// output that arrives later (pivoted-mode worker
						// replies) still gets the redraw treatment.
						$this->dumper->prompt_displayed = false;
					}
				);
				// readline drew the prompt itself — no manual fwrite needed.
				$this->dumper->mark_prompt_displayed();
			}

			private function show_prompt_fallback(): void {
				if ( $this->prompt_displayed ) {
					return;
				}
				\fwrite( \STDOUT, $this->shell->prompt );
				$this->dumper->mark_prompt_displayed();
				$this->prompt_displayed = true;
			}

			public function drain_fh(): void {
				if ( $this->has_readline ) {
					// Feed one byte from STDIN to readline. If it completed a
					// line, the callback (set in install_handler) appended to
					// $this->queue. Mirrors TTY.pm:drain_fh.
					\readline_callback_read_char();

					foreach ( $this->queue as $line ) {
						$msg = $this->shell->parse( $line );
						if ( null !== $msg ) {
							$this->shell->fill( $msg );
						}
					}
					$delivered = \count( $this->queue ) > 0;
					$this->queue = [];

					if ( $this->readline_eof ) {
						$this->exit = true;
						return;
					}
					if ( $delivered ) {
						// Handler was auto-removed when the line was delivered;
						// re-install so the next prompt renders.
						$this->install_handler();
					}
					return;
				}

				// Non-readline path: line-buffered fgets, manual prompt.
				$line = \fgets( $this->stream );
				if ( false === $line ) {
					// fgets returns false on EOF or no-data-available
					// (non-blocking). Distinguish via feof.
					if ( \feof( $this->stream ) ) {
						$this->exit = true;
					}
					return;
				}
				$line                   = \rtrim( $line, "\r\n" );
				$this->prompt_displayed = false;

				$msg = $this->shell->parse( $line );
				if ( null !== $msg ) {
					$this->shell->fill( $msg );
				}
				$this->show_prompt_fallback();
			}
		};

		EventFramework::instance()->register_reader_node( $stdin );

		EventFramework::instance()->drain( static fn () => ! $stdin->exit );

		EventFramework::instance()->unregister_reader_node( $stdin );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		\WP_CLI::log( '' ); // Trailing newline after EOF.
	}
}

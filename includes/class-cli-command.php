<?php
/**
 * Cli_Command: WP-CLI command wrapper for `wp nodes ls` and `wp nodes cli`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Cli_Command {

	private function base_dir(): string {
		return (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
	}

	/**
	 * List live workers, reporting each one's heartbeat age and freshness.
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
	 * Open an interactive REPL — bare mode (local graph) or pivoted mode (IPC to a worker).
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
		[ $shell, $dumper ] = $this->prepare_repl( $args );
		$this->run_repl( $shell, $dumper );
	}

	/**
	 * Build the REPL graph + log the mode line, returning [$shell, $dumper] for run_repl.
	 *
	 * @param array $args WP_CLI positional arguments. Empty = bare mode; else $args[0] is the reader id.
	 * @return array{0:Shell,1:Dumper}
	 */
	public function prepare_repl( array $args ): array {
		// Refuse root: a root cli would create the IPC dirs root-owned, so non-root clis lose writes.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			\WP_CLI::error( 'wp nodes cli must run as the same user as the workers, not root.' );
		}

		$cli = new Cli( $this->base_dir() );

		$pivoted = ! empty( $args );
		$ipc     = null;

		if ( $pivoted ) {
			$reader_id = $args[0];
			try {
				$ipc = $cli->attach_to_worker( $reader_id );
			} catch ( \InvalidArgumentException $e ) {
				\WP_CLI::error( $e->getMessage() );
			}
		}

		[ $shell, $dumper ] = $this->build_repl_graph( $pivoted, $ipc );

		// Stash the mode summary; the `status` builtin renders it on demand.
		if ( $pivoted && null !== $ipc ) {
			$shell->status_lines = [
				"Pivoted-cli mode for {$args[0]}",
				"  input  partition: {$ipc['input']}",
				"  output partition: {$ipc['output']}",
			];
		} else {
			$shell->status_lines = [
				'Bare cli mode (local nodes only).',
			];
		}

		return [ $shell, $dumper ];
	}

	/**
	 * Build the REPL node graph (bare: _shell → CI → _router → _output; pivoted adds IPC nodes).
	 *
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell,1:Dumper}
	 */
	private function build_repl_graph( bool $pivoted, ?array $ipc ): array {
		$pid = (string) \getmypid();

		$router = new Router();
		$router->name( Node_Names::ROUTER );

		$interpreter = new CommandInterpreter();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// `_output`: Shell stamps FROM=_output/$pid, so replies route back here.
		$dumper = new Dumper();
		$dumper->name( Node_Names::OUTPUT );

		// Shell stays anonymous (Shell::name would throw); `ls` filters by sink anyway.
		$shell = new Shell();
		$shell->sink( $interpreter );

		if ( $pivoted && null !== $ipc ) {
			$shell->prompt = "{$ipc['type']}.p{$ipc['partition']}> ";
		}

		$dumper->set_shell( $shell );
		// readline only works on a real TTY; on a pipe it spins at 100% CPU.
		$is_tty = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$dumper->set_readline_mode( $is_tty && \function_exists( 'readline_callback_handler_install' ) );

		if ( $pivoted && null !== $ipc ) {
			// IPC topics are single-partition; skip allow_large_writes so sessions append concurrently.
			$cmd_out = new Partition( $ipc['input'], 0 );
			$cmd_out->name( 'cmd-out' );
			$cmd_out->sink( $interpreter );
			$shell->sink( $cmd_out );

			// reply-in: ephemeral, so empty offsetlog_base_dir (no durable cursor).
			$reply_in = new Consumer( $ipc['output'], 0 );
			$reply_in->next_offset( 'end' );
			$reply_in->sink( $router );
			$reply_in->target( Node_Names::OUTPUT );
		}

		// TO filter matches `_output/$pid` and `$pid`; empty TO always renders, other sessions drop.
		$dumper->set_to_filter( $pid );

		return [ $shell, $dumper ];
	}

	/**
	 * Drive the REPL via the event loop until STDIN EOF. Readline on a TTY, fgets otherwise.
	 */
	private function run_repl( Shell $shell, Dumper $dumper ): void {
		// readline only on a real TTY; pipes fall through to fgets (EOF-terminating).
		$is_tty       = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$has_readline = $is_tty && \function_exists( 'readline_callback_handler_install' );

		// Wire STDOUT into the Shell for the `status` builtin.
		$shell->output_stream = \STDOUT;

		// Skip prompts when stdin is piped — they break `... | grep` consumers.
		$reader = new Cli_Stdin_Reader( $this, $shell, $dumper, $has_readline, null, $is_tty );

		// On the worker's TM_EOF echo, flip the exit flag so scripted sessions don't orphan replies.
		$dumper->on_eof( static function () use ( $reader ): void {
			$reader->exit = true;
		} );

		// Schedule the first fire; subsequent fires self-schedule.
		$reader->set_timer( 0, true );
		EventFramework::instance()->drain( static fn () => ! $reader->exit );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		// Courtesy trailing newline on a TTY; skipped when piped (stray noise breaks consumers).
		if ( $is_tty ) {
			\WP_CLI::log( '' );
		}
	}

	/**
	 * Parse one input line through the Shell graph (split into statements). True if any Message emitted.
	 */
	public function dispatch_line( Shell $shell, string $line ): bool {
		$line     = \rtrim( $line, "\r\n" );
		$dispatched = false;
		foreach ( $shell->split_statements( $line ) as $statement ) {
			$msg = $shell->parse( $statement );
			if ( null === $msg ) {
				continue;
			}
			$shell->fill( $msg );
			$dispatched = true;
		}
		return $dispatched;
	}
}

/**
 * Stdin-reading driver for `wp nodes cli`. Timer-driven: read $stream, dispatch, re-arm.
 *
 * @package Newspack_Nodes
 */
class Cli_Stdin_Reader extends Timer {
	/**
	 * `readline_callback_handler_install` seam. Tests reassign to a no-op.
	 *
	 * Signature: `function (string $prompt, callable $line_cb): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $readline_handler_install = null;

	/**
	 * `readline_callback_read_char` seam. Tests reassign to a no-op so fire() doesn't block on stdin.
	 *
	 * Signature: `function (): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $readline_read_char = null;

	/** @var resource */
	public $stream;
	public bool $exit = false;
	private Cli_Command $cmd;
	private Shell $shell;
	private Dumper $dumper;
	private bool $has_readline;
	private bool $show_prompts;
	private float $eof_deadline_s;
	private bool $prompt_displayed = false;
	/** @var array<int,string> Lines delivered by the readline callback, drained per fire(). */
	private array $queue = [];
	private bool $readline_eof = false;
	private bool $eof_sent = false;
	private float $eof_deadline_at = 0.0;
	private const IDLE_POLL_MS = 100; // No bytes pending — back off.
	private const BUSY_POLL_MS = 0;   // Bytes pending — drain ASAP next tick.
	private const EOF_POLL_MS  = 10;  // After TM_EOF emit — check deadline + watch for echo.

	/**
	 * @param resource|null $stream         Input stream (defaults to STDIN).
	 * @param bool          $show_prompts   Render the prompt before each read; false when piped.
	 * @param float         $eof_deadline_s Cap on waiting for the TM_EOF echo after stdin closes.
	 */
	public function __construct( Cli_Command $cmd, Shell $shell, Dumper $dumper, bool $has_readline, $stream = null, bool $show_prompts = true, float $eof_deadline_s = 5.0 ) {
		parent::__construct();
		$this->stream         = $stream ?? \STDIN;
		$this->cmd            = $cmd;
		$this->shell          = $shell;
		$this->dumper         = $dumper;
		$this->has_readline   = $has_readline;
		$this->show_prompts   = $show_prompts;
		$this->eof_deadline_s = $eof_deadline_s;

		if ( $has_readline ) {
			$this->install_handler();
		} else {
			@\stream_set_blocking( $this->stream, false );
			if ( $show_prompts ) {
				$this->show_prompt_fallback();
			}
		}
	}

	/**
	 * Stdin closed: emit a TM_EOF marker through the Shell and arm the deadline. Idempotent.
	 */
	private function send_eof_marker(): void {
		if ( $this->eof_sent ) {
			return;
		}
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_EOF;
		$msg[ Message::FROM ] = Node_Names::OUTPUT . '/' . \getmypid();
		$this->shell->fill( $msg );
		$this->eof_sent        = true;
		$this->eof_deadline_at = \microtime( true ) + $this->eof_deadline_s;
	}

	/**
	 * (Re-)install the readline callback handler with the real prompt.
	 *
	 * PHP auto-removes the handler per delivered line; the real-prompt width stops
	 * backspace from chewing through the prompt once the buffer empties.
	 */
	private function install_handler(): void {
		$install = self::$readline_handler_install ?? static function ( string $prompt, callable $cb ): void {
			\readline_callback_handler_install( $prompt, $cb );
		};
		$install(
			$this->shell->prompt,
			fn ( $line ) => $this->handle_readline_line( $line )
		);
		$this->dumper->mark_prompt_displayed();
	}

	/**
	 * Body of the readline-callback closure (public for tests): null → EOF, else queue the line.
	 */
	public function handle_readline_line( ?string $line ): void {
		if ( null === $line ) {
			$this->readline_eof = true;
			return;
		}
		if ( '' !== $line && \function_exists( 'readline_add_history' ) ) {
			\readline_add_history( $line );
		}
		$this->queue[] = $line;
		$this->dumper->prompt_displayed = false;
	}

	private function show_prompt_fallback(): void {
		if ( $this->prompt_displayed ) {
			return;
		}
		// Routed through Dumper so a memory-stream Dumper doesn't pollute phpunit's STDOUT.
		$this->dumper->write_prompt( $this->shell->prompt );
		$this->prompt_displayed = true;
	}

	/**
	 * Timer override: drain $this->stream, dispatch, re-arm (busy/EOF/idle cadence).
	 */
	public function fire(): void {
		// Exit if TM_EOF was emitted and the echo never came back within the deadline.
		if ( $this->eof_sent && \microtime( true ) >= $this->eof_deadline_at ) {
			$this->exit = true;
			return;
		}

		$delivered = false;

		if ( $this->has_readline ) {
			// Gate the readline read on stdin having data — rl_getc blocks on an idle TTY,
			// stalling the drain loop. Memory streams (tests) throw ValueError → fall through.
			$ready = 1;
			try {
				$read   = [ $this->stream ];
				$write  = null;
				$except = null;
				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				$ready  = (int) @\stream_select( $read, $write, $except, 0, 0 );
			} catch ( \ValueError $e ) {
				$ready = 1;
			}
			if ( $ready > 0 ) {
				$read_char = self::$readline_read_char ?? static function (): void {
					\readline_callback_read_char();
				};
				$read_char();

				foreach ( $this->queue as $line ) {
					$this->cmd->dispatch_line( $this->shell, $line );
					$delivered = true;
				}
				$this->queue = [];

				if ( $this->readline_eof ) {
					$this->send_eof_marker();
				} elseif ( $delivered ) {
					// Handler auto-removed on delivery; re-install for the next prompt.
					$this->install_handler();
				}

				$delivered = true;
			}
		} else {
			// Non-readline path: line-buffered fgets, manual prompt.
			$line = \fgets( $this->stream );
			if ( false === $line ) {
				// false on EOF or no-data (non-blocking); distinguish via feof.
				if ( \feof( $this->stream ) ) {
					$this->send_eof_marker();
				}
			} else {
				$this->prompt_displayed = false;
				$this->cmd->dispatch_line( $this->shell, $line );
				if ( $this->show_prompts ) {
					$this->show_prompt_fallback();
				}
				$delivered = true;
			}
		}

		// Re-arm (oneshot — self-schedule each cycle); exit first if $exit got flipped.
		if ( $this->exit ) {
			return;
		}
		if ( $delivered ) {
			$next_ms = self::BUSY_POLL_MS;
		} elseif ( $this->eof_sent ) {
			$next_ms = self::EOF_POLL_MS;
		} else {
			$next_ms = self::IDLE_POLL_MS;
		}
		$this->set_timer( $next_ms, true );
	}
}

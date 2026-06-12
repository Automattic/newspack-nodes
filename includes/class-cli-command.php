<?php
/**
 * Cli_Command: WP-CLI command wrapper for `wp nodes ls` and `wp nodes cli`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class CLI_Command {

	/**
	 * Open an interactive REPL — bare mode (local graph) or pivoted mode (IPC to a worker).
	 *
	 * ## OPTIONS
	 *
	 * [<worker>]
	 * : Worker id in the form {type}.p{N}, e.g. firehose-workers.p0.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes cli
	 *     wp nodes cli firehose-workers.p0
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function cli( array $args, array $assoc_args ): void {
		[ $shell, $dumper ] = $this->prepare_repl( $args );
		$this->run_repl( $shell, $dumper );
	}

	/**
	 * Build the REPL graph + log the mode line, returning [$shell, $dumper] for run_repl.
	 *
	 * @param array<int, string> $args WP_CLI positional arguments. Empty = bare mode; else $args[0] is the worker id.
	 * @return array{0:Shell_Node,1:Dumper_Node}
	 */
	public function prepare_repl( array $args ): array {
		// Refuse root: a root cli would create the IPC dirs root-owned, so non-root clis lose writes.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			\WP_CLI::error( 'wp nodes cli must run as the same user as the workers, not root.' );
		}

		$cli = new CLI( $this->base_dir() );

		$pivoted = ! empty( $args );
		$ipc     = null;

		if ( $pivoted ) {
			$worker_id = $args[0];
			try {
				$ipc = $cli->attach_to_worker( $worker_id );
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

	private function base_dir(): string {
		return Config::get_base_directory();
	}

	/**
	 * Build the REPL node graph (bare: _shell → interpreter → _router → _output; pivoted adds IPC nodes).
	 *
	 * @param array{input:string,output:string,type:string,partition:int}|null $ipc
	 * @return array{0:Shell_Node,1:Dumper_Node}
	 */
	private function build_repl_graph( bool $pivoted, ?array $ipc ): array {
		$pid = (string) \getmypid();

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// `_output`: Shell stamps FROM=_output/$pid, so replies route back here.
		$dumper = new Dumper_Node();
		$dumper->name( Node_Names::OUTPUT );

		// Shell stays anonymous (Shell::name would throw); `ls` filters by sink anyway.
		$shell = new Shell_Node();
		$shell->sink( $interpreter );
		// Defined unconditionally (empty in bare mode) so it's in scope for both
		// pivoted blocks below; the blocks themselves are guarded.
		$worker_id = ( $pivoted && null !== $ipc ) ? "{$ipc['type']}.p{$ipc['partition']}" : '';
		if ( $pivoted && null !== $ipc ) {
			$shell->prompt = "/{$worker_id}> ";
		}

		$dumper->set_shell( $shell );
		// readline only works on a real TTY; on a pipe it spins at 100% CPU.
		$is_tty = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$dumper->set_readline_mode( $is_tty && \function_exists( 'readline_callback_handler_install' ) );

		if ( $pivoted && null !== $ipc ) {
			// IPC topics are single-partition; skip allow_large_writes so sessions append concurrently.
			// 1 MiB segment_size + 2 segments — matches the worker/server IPC mounts.
			$ipc_out = new Partition_Node();
			$ipc_out->arguments( "{$ipc['input']} 0 " . Worker_Base::IPC_SEGMENT_SIZE . ' ' . Worker_Base::IPC_NUM_SEGMENTS );
			$ipc_out->name( $worker_id );
			$ipc_out->sink( $interpreter );
			$shell->sink( $interpreter );
			$shell->path = $worker_id;

			// reply-in: ephemeral, so empty offsetlog_base_dir (no durable cursor).
			$reply_in = new Consumer_Node();
			$reply_in->arguments( "{$ipc['output']} 0" );
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
	private function run_repl( Shell_Node $shell, Dumper_Node $dumper ): void {
		// readline only on a real TTY; pipes fall through to fgets (EOF-terminating).
		$is_tty       = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$has_readline = $is_tty && \function_exists( 'readline_callback_handler_install' );

		// Skip prompts when stdin is piped — they break `... | grep` consumers.
		$reader = new CLI_Stdin_Reader_Node( $this, $shell, $dumper, $has_readline, null, $is_tty );

		// Every node sinks into the interpreter (only Router has none). The reader is
		// a Timer_Node, and Timer_Node::fire_cb() skips fire() when sink is null — so
		// without this its stdin drain never runs and the REPL ignores all input.
		$reader->sink( Core::node( Node_Names::COMMAND_INTERPRETER ) );

		// On the worker's TM_EOF echo, flip the exit flag so scripted sessions don't orphan replies.
		$dumper->on_eof( static function () use ( $reader ): void {
			$reader->exit = true;
		} );

		// Schedule the first fire; subsequent fires self-schedule.
		$reader->set_timer( 0, true );
		Event_Framework::instance()->drain( static fn () => ! $reader->exit );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		// Courtesy trailing newline on a TTY; skipped when piped (stray noise breaks consumers).
		if ( $is_tty ) {
			\WP_CLI::log( '' );
		}
	}

	/**
	 * List live workers, reporting each one's heartbeat age and freshness.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes ls
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function ls( array $args, array $assoc_args ): void {
		$cli     = new CLI( $this->base_dir() );
		$workers = $cli->ls_workers();
		if ( empty( $workers ) ) {
			\WP_CLI::log( 'No workers running. base_dir=' . $this->base_dir() );
			return;
		}
		$now = \time();
		foreach ( $workers as $w ) {
			$age      = $w['heartbeat_at'] ? ( $now - $w['heartbeat_at'] ) . 's ago' : 'never';
			$flag     = $w['stale'] ? '[stale]' : '[live] ';
			$worker   = "{$w['type']}.p{$w['partition']}";
			\WP_CLI::log( \sprintf( '%s %-30s heartbeat %s', $flag, $worker, $age ) );
		}
	}

	/**
	 * Parse one input line through the Shell graph (split into statements). True if any Message emitted.
	 */
	public function dispatch_line( Shell_Node $shell, string $line ): bool {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $line;
		$before = $shell->counter();
		$shell->fill( $message );
		$after = $shell->counter();
		return $after > $before;
	}
}

/**
 * Stdin-reading driver for `wp nodes cli`. Timer-driven: read $stream, dispatch, re-arm.
 *
 * @package Newspack_Nodes
 */
class CLI_Stdin_Reader_Node extends Timer_Node {
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

	/**
	 * `readline_completion_function` seam. Lazily-defaulted to a closure that
	 * wraps the real libreadline call. Tests reassign in bootstrap to capture the
	 * registration without invoking libreadline (which needs a real TTY) — that
	 * lets the suite still cover install_completion()'s surrounding logic.
	 *
	 * Signature: `function ( callable $completion_cb ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $readline_completion_register = null;

	/** @var array<int,string> Cached command-verb candidates (from `help` KEY=completion). */
	private array $command_candidates = [];

	/** @var array<int,string> Cached node-name candidates (from `ls` KEY=completion). */
	private array $node_candidates = [];

	/** @var resource */
	public $stream;
	public bool $exit = false;
	private CLI_Command $cmd;
	private Shell_Node $shell;
	private Dumper_Node $dumper;
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
	public function __construct( CLI_Command $cmd, Shell_Node $shell, Dumper_Node $dumper, bool $has_readline, $stream = null, bool $show_prompts = true, float $eof_deadline_s = 5.0 ) {
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
			$this->install_completion();
			// Seed the cache so the very first Tab has candidates (the reply lands async).
			$this->send_completion_queries();
		} else {
			@\stream_set_blocking( $this->stream, false );
			if ( $show_prompts ) {
				$this->show_prompt_fallback();
			}
		}
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

	/**
	 * Stdin closed: emit a TM_EOF marker through the Shell and arm the deadline. Idempotent.
	 */
	private function send_eof_marker(): void {
		if ( $this->eof_sent ) {
			return;
		}
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_EOF;
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
			fn ( ?string $line ) => $this->handle_readline_line( $line )
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
	 * Wire tab-completion: register the readline completion callback against the
	 * live candidate cache, and route the Dumper's completion replies into the
	 * cache. readline's completion function receives the word + its character
	 * offset; offset 0 = first token (command verbs), else an argument (nodes).
	 * readline performs the LCP + listing from the array we return.
	 *
	 * Gated by the caller behind the same TTY / function_exists checks as the
	 * readline handler; the seam lets tests capture the registration without a TTY.
	 */
	private function install_completion(): void {
		$this->dumper->set_completion_sink(
			fn ( array $message ): bool => $this->ingest_completion_reply( $message )
		);
		$register = self::$readline_completion_register ?? static function ( callable $cb ): void {
			\readline_completion_function( $cb );
		};
		$register(
			function ( string $word, int $index ): array {
				// Refresh the cache for the NEXT Tab (the reply lands async, so this
				// keystroke completes against the previous snapshot — one-Tab-stale).
				$this->send_completion_queries();
				return $this->complete( $word, $index );
			}
		);
	}

	/**
	 * Build a completion-query Message (`help` for verbs, `ls` for node names),
	 * routed to the current pivot (cwd) so candidates come from the right graph.
	 *
	 * KEY='completion' makes the interpreter's help / list_nodes verbs emit a bare
	 * newline-separated candidate list (no headers, no column flags). FROM is the
	 * cli's reply path so the answer lands on this session's Dumper; LOCAL marks
	 * it in-process.
	 *
	 * @param string $verb Either 'help' (command candidates) or 'ls' (node candidates).
	 * @return array<int,mixed> The TM_BYTESTREAM Message.
	 */
	public function build_completion_query( string $verb ): array {
		$msg                    = Message::new_message();
		$msg[ Message::TYPE ]   = Message::TM_BYTESTREAM;
		$msg[ Message::KEY ]    = 'completion';
		$msg[ Message::VALUE ]  = $verb;
		return $msg;
	}

	/**
	 * Send both completion queries through the Shell so they ride the same
	 * CommandInterpreter path as any typed command. The replies land
	 * asynchronously and update the cache for the NEXT Tab — completion is
	 * thus one keystroke stale, which is acceptable for an interactive REPL.
	 */
	public function send_completion_queries(): void {
		$help = $this->build_completion_query( 'help' );
		$this->shell->fill( $help );
		$ls = $this->build_completion_query( 'ls' );
		$this->shell->fill( $ls );
	}

	/**
	 * Ingest a completion reply into the cache. Returns true (consumed) only for
	 * KEY='completion' command responses; the Dumper drops consumed replies so
	 * they don't print. `help` fills the command cache; `ls`/`list_nodes` the
	 * node cache. Each ingest REPLACES the relevant list (nodes come and go).
	 *
	 * @param array<array-key,mixed> $message Inbound reply.
	 * @return bool True if this was a completion reply (consume; don't render).
	 */
	public function ingest_completion_reply( array $message ): bool {
		if ( 'completion' !== ( $message[ Message::KEY ] ?? '' ) ) {
			return false;
		}
		$value = $message[ Message::VALUE ] ?? null;
		if ( ! \is_array( $value ) ) {
			return false;
		}
		$raw_name    = $value['name'] ?? '';
		$raw_payload = $value['payload'] ?? '';
		$name        = \is_scalar( $raw_name ) ? (string) $raw_name : '';
		$payload     = \is_scalar( $raw_payload ) ? (string) $raw_payload : '';
		$list    = '' === $payload ? [] : \explode( "\n", $payload );

		if ( 'help' === $name ) {
			$this->command_candidates = $list;
		} else {
			// `ls` and its canonical `list_nodes` both fill the node cache.
			$this->node_candidates = $list;
		}
		return true;
	}

	/**
	 * Return cached candidates whose prefix matches $word. The FIRST token on the
	 * line (index 0) completes against command verbs; later tokens (arguments)
	 * complete against node names. readline does the LCP + listing from the array
	 * we return here.
	 *
	 * @param string $word  The word being completed.
	 * @param int    $index Token position on the line (0 = first token).
	 * @return array<int,string>
	 */
	public function complete( string $word, int $index ): array {
		$pool = ( 0 === $index ) ? $this->command_candidates : $this->node_candidates;
		if ( '' === $word ) {
			return \array_values( $pool );
		}
		return \array_values(
			\array_filter( $pool, static fn ( string $c ): bool => \str_starts_with( $c, $word ) )
		);
	}

	/** @return array<int,string> Test/inspection accessor for the command-verb cache. */
	public function command_candidates(): array {
		return $this->command_candidates;
	}

	/** @return array<int,string> Test/inspection accessor for the node-name cache. */
	public function node_candidates(): array {
		return $this->node_candidates;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Standard input for CLI REPL.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}

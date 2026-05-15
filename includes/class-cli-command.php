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
		return (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
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
	 * _output + _shell + _output graph; commands run against this process.
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
		[ $shell, $dumper ] = $this->prepare_repl( $args );
		$this->run_repl( $shell, $dumper );
	}

	/**
	 * Build the REPL graph + log the mode line, returning [$shell, $dumper]
	 * ready for `run_repl`. Extracted from `cli()` so tests can verify the
	 * setup branches (root guard, attach error, log shape) without entering
	 * the blocking event loop.
	 *
	 * On root or invalid reader id, calls WP_CLI::error which is configured
	 * by tests to throw, so this method has no return value path for the
	 * error branches — the caller (cli()) returns implicitly when the
	 * underlying WP_CLI::error short-circuits.
	 *
	 * @param array $args WP_CLI positional arguments. Empty = bare mode;
	 *                    otherwise $args[0] is the reader id.
	 * @return array{0:Shell,1:Dumper}
	 */
	public function prepare_repl( array $args ): array {
		// Refuse to run as root. Workers run as the web user and create the
		// IPC dirs under that ownership; a root cli would create `input/p0/`
		// (and its descendants) as root, leaving non-root clis unable to
		// write into the dir afterward — typed lines would silently vanish.
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

		// Build the graph first so we have a Shell to populate.
		[ $shell, $dumper ] = $this->build_repl_graph( $pivoted, $ipc );

		// Stash the mode summary on the Shell — `status` builtin renders it
		// on demand. Suppresses the previous auto-banner so scripted callers
		// (`echo cmd | wp nodes cli ...`) get clean output.
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
	 * Build the REPL node graph and return [Shell, Dumper] for the loop driver.
	 *
	 * Layout (bare):
	 *   _shell → _command_interpreter → _router → _output
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

		// Dumper is registered as `_output` because Shell stamps outgoing
		// messages with `FROM=_output/$pid` — replies route via
		// `TO=_output/$pid` → Router looks up `_output` → forwards with
		// `TO=$pid`. Dumper's TO filter matches `$pid` (or the pre-peel
		// form `_output/$pid`) so other sessions' replies fall through.
		$dumper = new Dumper();
		$dumper->name( '_output' );

		// Router fans into Dumper for messages Router can't dispatch (async
		// broadcasts, TO=='' replies that fell through TO-prefix peeling).
		$router->sink( $dumper );

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
		// readline only works on a real TTY — readline_callback_read_char()
		// reads from the TTY layer, not the stream descriptor, so feeding it a
		// pipe (heredoc, redirected file) leaves bytes unread while
		// stream_select keeps reporting STDIN ready → 100% CPU spin loop.
		$is_tty = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$dumper->set_readline_mode( $is_tty && \function_exists( 'readline_callback_handler_install' ) );

		if ( $pivoted && null !== $ipc ) {
			// Pivoted: shell → cmd-out (Partition auto-packs each emitted
			// Message via Message::packed → segment). reply-in (Consumer
			// auto-unpacks the worker's reply Partition → Message) → _router
			// (dispatches by TO=_output/$pid → _output → Dumper).
			// IPC topics are single-partition (p0); the outer partition number
			// (.p3) lives in the topic dir, so constructors use partition=0.

			// Typed cli commands are small (a few hundred bytes at most), so
			// the default PIPE_BUF cap is fine and we don't need
			// allow_large_writes(). Skipping it lets multiple cli sessions
			// append concurrently without contending on the single-writer
			// claim — Partition's small-write path is unlocked PIPE_BUF
			// atomic appends. (The reverse direction, worker→cli, can
			// produce >4KB output via dump_node, so the worker's `_repl`
			// Partition still uses allow_large_writes.)
			$cmd_out = new Partition( $ipc['input'], 0 );
			$cmd_out->name( 'cmd-out' );
			$cmd_out->sink( $interpreter );
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
		} else {
			$echo = new Echo_Node();
			$echo->name( '_repl' );
			$echo->sink( $interpreter );
		}

		// Dumper TO filter: matches `_output/$pid` (worker reply with
		// `_output` not yet peeled) and `$pid` (worker reply with
		// `_output` already peeled by _router). Empty TO is always rendered
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
	/**
	 * Parse one line of input through the Shell graph. Extracted so tests
	 * can drive the per-line dispatch directly from a memory stream without
	 * spinning up the event loop. Returns true when the line emitted a
	 * Message (was a real verb), false when it was a no-op (empty line,
	 * comment, builtin like `cd`, `include`).
	 */
	public function dispatch_line( Shell $shell, string $line ): bool {
		$line = \rtrim( $line, "\r\n" );
		$msg  = $shell->parse( $line );
		if ( null === $msg ) {
			return false;
		}
		$shell->fill( $msg );
		return true;
	}

	/**
	 * Drain a non-blocking input stream of complete lines, dispatching each
	 * through the Shell. Returns the number of lines processed; 0 typically
	 * means EOF (caller can flip its exit flag). Used by `run_repl`'s
	 * non-readline path AND directly by tests via `php://memory` stream
	 * injection — readline's per-byte feed isn't testable without a real
	 * TTY, but the line-buffered branch covers the same parse/fill contract.
	 */
	public function drain_lines_from_stream( Shell $shell, $stream ): int {
		$processed = 0;
		while ( ( $line = \fgets( $stream ) ) !== false ) {
			$this->dispatch_line( $shell, $line );
			++$processed;
		}
		return $processed;
	}

	private function run_repl( Shell $shell, Dumper $dumper ): void {
		// Same gate as the Dumper's readline_mode: only use readline when STDIN
		// is a real TTY. Pipes / redirected files fall through to the
		// non-blocking fgets path which terminates cleanly on EOF.
		$is_tty       = \function_exists( 'posix_isatty' ) && @\posix_isatty( \STDIN );
		$has_readline = $is_tty && \function_exists( 'readline_callback_handler_install' );

		// Wire STDOUT into the Shell so the `status` local builtin has
		// somewhere to render. (Tests inject memory streams directly.)
		$shell->output_stream = \STDOUT;

		// Skip prompt rendering when stdin is piped — prompts in captured
		// output break shell consumers (e.g. `... | grep`).
		$reader = new Cli_Stdin_Reader( $this, $shell, $dumper, $has_readline, null, $is_tty );

		// Stdin-EOF round-trip: when the worker's TM_EOF echo lands on the
		// reply partition and Dumper renders it, flip the reader's exit
		// flag so the drain loop terminates. Without this, scripted cli
		// sessions race — stdin closes, cli exits, pending replies are
		// orphaned on disk.
		$dumper->on_eof( static function () use ( $reader ): void {
			$reader->exit = true;
		} );

		// Cli_Stdin_Reader is timer-driven (extends Timer); schedule its
		// first fire so the drain loop has at least one timer to wait on.
		// Subsequent fires self-schedule via set_timer at end of fire().
		$reader->set_timer( 0, true );
		EventFramework::instance()->drain( static fn () => ! $reader->exit );

		if ( $has_readline ) {
			\readline_callback_handler_remove();
		}
		\WP_CLI::log( '' ); // Trailing newline after EOF.
	}
}

/**
 * Stdin-reading driver for `wp nodes cli`. Timer-driven (extends Timer):
 * each tick reads what's available on $stream, dispatches through the
 * Shell, then re-arms with set_timer(0) (more bytes pending — drain ASAP,
 * crucial for piped-stdin throughput) or set_timer(100) (idle — back off
 * to 100ms polling). Mirrors how Tail and Consumer self-schedule.
 *
 * Tests instantiate directly with a `php://memory` stream and call `fire()`
 * to drive a deterministic number of dispatches without entering the
 * EventFramework drain loop.
 *
 * @package Newspack_Nodes
 */
class Cli_Stdin_Reader extends Timer {
	/**
	 * `readline_callback_handler_install` seam — defaults to the real
	 * libreadline call (lazy-initialized inside `install_handler`).
	 * Tests reassign to a no-op so phpunit-in-a-terminal (where stdin
	 * IS a tty, so we can't gate on `posix_isatty`) doesn't get the
	 * raw prompt written to fd 1 and put the terminal into callback
	 * mode. Pattern mirrors `Supervisor::$curl_exec`.
	 *
	 * Signature: `function (string $prompt, callable $line_cb): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $readline_handler_install = null;

	/**
	 * `readline_callback_read_char` seam — same pattern, defaults to
	 * the real call. Tests reassign to a no-op so a test exercising
	 * `fire()` in readline mode doesn't block on real stdin.
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
	/** Stdin-EOF round-trip state. */
	private bool $eof_sent = false;
	private float $eof_deadline_at = 0.0;
	/** Re-arm cadences. */
	private const IDLE_POLL_MS = 100; // No bytes pending — back off.
	private const BUSY_POLL_MS = 0;   // Bytes pending — drain ASAP next tick.
	private const EOF_POLL_MS  = 10;  // After TM_EOF emit — check deadline + watch for echo.

	/**
	 * @param resource|null $stream         Input stream (defaults to STDIN). Tests
	 *                                      pass a `php://memory` resource so the
	 *                                      fgets path is exercisable without
	 *                                      real STDIN.
	 * @param bool          $show_prompts   Render the shell prompt before each
	 *                                      read. Default true. Pass false when
	 *                                      stdin is piped (no TTY) — prompts
	 *                                      pollute scripted output.
	 * @param float         $eof_deadline_s Bound on how long to wait for the
	 *                                      TM_EOF echo after stdin closes
	 *                                      before exiting anyway. Default 5s.
	 *                                      A dead worker would otherwise hang
	 *                                      the cli forever; the deadline is
	 *                                      the cap. Bare mode echoes
	 *                                      synchronously inside the same
	 *                                      drain so the deadline rarely
	 *                                      matters there.
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
	 * Stdin closed: emit a TM_EOF marker through the Shell and arm the
	 * deadline. Mirrors Tachikoma `FileHandle::handle_EOF` → `send_EOF`.
	 * The receiving CommandInterpreter (local in bare mode, the worker's
	 * in pivoted mode) bounces TO=FROM, the echo walks back to our Dumper,
	 * Dumper fires the on_eof callback (wired by run_repl), $exit flips.
	 *
	 * Idempotent — only the first call emits. Subsequent calls (each
	 * drain_fh tick after stdin closed) are no-ops until the deadline
	 * elapses or the echo arrives.
	 */
	private function send_eof_marker(): void {
		if ( $this->eof_sent ) {
			return;
		}
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_EOF;
		$msg[ Message::FROM ] = '_output/' . \getmypid();
		$this->shell->fill( $msg );
		$this->eof_sent        = true;
		$this->eof_deadline_at = \microtime( true ) + $this->eof_deadline_s;
	}

	/**
	 * (Re-)install the readline callback handler. PHP auto-removes the
	 * handler after each line is delivered, so we install once at startup
	 * and again after every processed line so the next prompt renders.
	 *
	 * Install with the REAL prompt so readline knows the prompt's width —
	 * that's what stops backspace from chewing back through the prompt
	 * characters once the buffer empties (readline tracks cursor as
	 * `prompt-end-col + buffer-point`, so an empty prompt places the
	 * buffer at col 0 and a redraw happily overwrites our manually-
	 * written prompt).
	 */
	private function install_handler(): void {
		// Production: real `readline_callback_handler_install` writes the
		// prompt to fd 1 and puts the tty into callback mode. Tests
		// override via `self::$readline_handler_install` to skip the
		// real call so a phpunit-in-a-terminal run (where stdin IS a
		// tty, gating on `posix_isatty` is useless) doesn't pollute
		// fd 1 with raw bytes. The dumper's `prompt_displayed`
		// invariant flips either way.
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
	 * Body of the readline-callback closure. Public so tests can drive it
	 * directly without spinning a real readline TTY.
	 *
	 *  - null line → user pressed Ctrl-D / readline EOF; flip the EOF flag
	 *    so the next drain_fh call exits the event loop.
	 *  - non-empty line → record in readline history (if extension available)
	 *    and queue it for processing.
	 *  - any line → clear the dumper's prompt-displayed flag so synchronous
	 *    output during queue processing writes plainly instead of doing the
	 *    async wipe-and-redisplay dance.
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
		// Routed through Dumper so tests with a memory-stream Dumper don't
		// pollute phpunit's real STDOUT. write_prompt() also flips the
		// dumper's prompt_displayed flag (replacing the prior pair of
		// fwrite + mark_prompt_displayed).
		$this->dumper->write_prompt( $this->shell->prompt );
		$this->prompt_displayed = true;
	}

	/**
	 * Timer override: drain whatever's ready on $this->stream, dispatch
	 * through the Shell, re-arm for the next tick. Cadence picked from the
	 * state we left this tick in:
	 *  - delivered a line/byte → set_timer(0): there might be more, drain ASAP.
	 *    Critical for piped-stdin throughput (`echo big_script | wp nodes cli`)
	 *    where the kernel has many lines buffered ready to read.
	 *  - waiting for TM_EOF echo → set_timer(10): tight loop to notice the
	 *    deadline or the echo within ~10ms.
	 *  - idle → set_timer(100): no bytes; back off to 100ms polling.
	 *
	 * Tests call this directly with a fixture stream + assert on the Shell's
	 * sink to verify dispatch.
	 */
	public function fire(): void {
		// Post-EOF deadline check: if we've already emitted TM_EOF and the
		// echo never came back, exit anyway after the configured bound.
		// Runs first so even ticks where stdin is silent still get checked.
		if ( $this->eof_sent && \microtime( true ) >= $this->eof_deadline_at ) {
			$this->exit = true;
			return;
		}

		$delivered = false;

		if ( $this->has_readline ) {
			// Gate the readline read on stdin actually having data. readline's
			// rl_getc layer blocks on a TTY with no pending input — left
			// ungated it stalls the entire drain loop inside the read syscall
			// until the user types again, which is what prevents Consumer/Tail
			// timers (notably the pivoted-cli reply-in Consumer) from firing
			// between commands. The legacy stream_select-driven loop gated
			// this externally; we do it inline now that EventFramework polls
			// timers only.
			//
			// Memory streams (php://memory in tests) have no underlying FD —
			// stream_select throws ValueError on them. Tests with memory
			// streams aren't blocking anyway, so fall through to the read.
			$ready = 1;
			try {
				$read   = [ $this->stream ];
				$write  = null;
				$except = null;
				// Suppress the companion E_WARNING that PHP raises alongside
				// the ValueError on un-selectable streams (php://memory in
				// tests). The catch handles the failure path; the warning
				// would just be noise in `phpunit --display-warnings`.
				// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				$ready  = (int) @\stream_select( $read, $write, $except, 0, 0 );
			} catch ( \ValueError $e ) {
				$ready = 1;
			}
			if ( $ready > 0 ) {
				// Feed one byte from STDIN to readline. If it completed a line,
				// the callback (set in install_handler) appended to $this->queue.
				// Tests override via `self::$readline_read_char` to no-op,
				// preventing a stdin-block when phpunit runs in a terminal.
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
					// Handler was auto-removed when the line was delivered;
					// re-install so the next prompt renders.
					$this->install_handler();
				}

				// We just consumed a char (or readline buffered it). Either
				// way stdin had data; flag delivered so the re-arm picks
				// BUSY_POLL_MS=0 and drains the rest of the kernel buffer
				// ASAP. Without this, fast typing crawls at 1 char per
				// IDLE_POLL_MS (100ms) because $delivered only flips on full
				// line completion.
				$delivered = true;
			}
		} else {
			// Non-readline path: line-buffered fgets, manual prompt.
			$line = \fgets( $this->stream );
			if ( false === $line ) {
				// fgets returns false on EOF or no-data-available (non-
				// blocking). Distinguish via feof.
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

		// Re-arm for the next tick (oneshot — we self-schedule each cycle).
		// Run loop exits ahead of any re-arm if $exit got flipped (deadline,
		// or run_repl's on_eof callback after the echo).
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

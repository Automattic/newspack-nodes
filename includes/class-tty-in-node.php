<?php
/**
 * TTY_In: the readline-backed stdin reader `wp nodes cli` drives its REPL from.
 *
 * `Stdin_Node` polls a stream with a non-blocking `fgets`; this subclass adds
 * the three things an interactive terminal wants on top — a live prompt, line
 * history and tab completion — without giving up that cadence, so the one drain
 * loop keeps servicing timers, the IPC Consumer and cURL handles between
 * keystrokes. Every libreadline call sits behind a static closure seam, because
 * the real functions read a TTY the test runner does not have.
 *
 * The reader sinks into the Shell, so the base emit primitives already deliver a
 * typed line into the parser and there is nothing here to override; the
 * `$shell` reference exists to read the live prompt. Completion rides the same
 * path as anything else typed: `help` and `ls` go out through that Shell
 * carrying `KEY='completion'`, and the replies come back through the session's
 * Dumper into the candidate caches below.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The `wp nodes cli` reader: readline when stdin is a terminal, the inherited
 * `fgets` drain when it is not.
 *
 * The caller decides which, and passes the answer in as `$has_readline`.
 * `readline_callback_read_char()` reads the TTY layer rather than the stream
 * descriptor, so a piped session that took the readline path would spin at 100%
 * CPU on a stream readline never sees.
 */
class TTY_In_Node extends Stdin_Node {

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

	/** @var array<int,string> Cached command-verb candidates (from `help` KEY=completion). */
	private array $command_candidates = [];

	/** Whether this session drives readline; false takes the inherited `fgets` drain. */
	private bool $has_readline;

	/** @var array<int,string> Cached node-name candidates (from `ls` KEY=completion). */
	private array $node_candidates = [];

	/** `_stdout`: every prompt is written through it, so a memory-stream session writes nowhere real. */
	private TTY_Out_Node $out;

	/** Whether the fallback prompt is on screen. Only the non-readline path tracks it; readline redraws its own. */
	private bool $prompt_displayed = false;

	/** @var array<int,string> Lines delivered by the readline callback, drained per fire(). */
	private array $queue = [];

	/** Set when readline hands back null (Ctrl-D); the next drain turns it into TM_EOF. */
	private bool $readline_eof = false;

	/** The parser this reader sinks into. Read here only for its live prompt. */
	private Shell_Node $shell;

	/** Whether to render a prompt before each read. False when stdin is piped, where a prompt corrupts the consumer's stream. */
	private bool $show_prompts;

	/**
	 * Wire the reader to its Shell and its terminal, installing readline when the
	 * caller found one.
	 *
	 * Registering completion happens here; seeding the candidate cache does not.
	 * `CLI_Command::run_repl()` fires the first queries once the Dumper's
	 * completion intercept is wired, and a query sent ahead of that has nothing
	 * to consume its reply — both candidate lists print on the operator's
	 * terminal instead.
	 *
	 * @param Shell_Node    $shell          Parser this reader sinks into; read here for its live prompt.
	 * @param TTY_Out_Node  $out            `_stdout`, the writer prompts go through.
	 * @param bool          $has_readline   Drive libreadline; false takes the inherited `fgets` drain.
	 * @param resource|null $stream         Input stream (defaults to STDIN); set non-blocking.
	 * @param bool          $show_prompts   Render the prompt before each read; false when piped.
	 * @param float         $eof_deadline_s Cap on waiting for the TM_EOF echo after stdin closes.
	 */
	public function __construct( Shell_Node $shell, TTY_Out_Node $out, bool $has_readline, $stream = null, bool $show_prompts = true, float $eof_deadline_s = 5.0 ) {
		parent::__construct( $stream, $eof_deadline_s );
		$this->shell        = $shell;
		$this->out          = $out;
		$this->has_readline = $has_readline;
		$this->show_prompts = $show_prompts;

		if ( $has_readline ) {
			$this->install_handler();
			$this->install_completion();
			// Cache seed deferred to run_repl; else replies dump to terminal.
		} elseif ( $show_prompts ) {
			$this->show_prompt_fallback();
		}
	}

	/**
	 * Drain one cycle: readline reads a character and delivers whatever lines
	 * completed, or the inherited `fgets` drain runs. Either way the base emit
	 * primitives fill the sink, which is the Shell.
	 *
	 * `stream_select` gates the readline read because `rl_getc` blocks on an idle
	 * TTY, and one blocking read holds the whole drain loop until the operator
	 * types. The readline path reports true for any pending byte rather than only
	 * for a completed line, which keeps `fire()` on its busy cadence while a line
	 * is still being typed. PHP removes the callback handler once it delivers a
	 * line, so a delivery re-installs it for the next prompt.
	 *
	 * @return bool True when readline had bytes to read, or the base drain delivered a line.
	 */
	protected function drain_once(): bool {
		if ( ! $this->has_readline ) {
			$delivered = parent::drain_once();
			if ( $delivered && $this->show_prompts ) {
				// Fresh prompt after each processed line (reader parity).
				$this->prompt_displayed = false;
				$this->show_prompt_fallback();
			}
			return $delivered;
		}

		// Gate readline read on stdin data — rl_getc blocks on an idle TTY.
		$ready = 1;
		try {
			$read   = [ $this->stream ];
			$write  = null;
			$except = null;
			// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$ready  = (int) @\stream_select( $read, $write, $except, 0, 0 );
		} catch ( \ValueError $e ) {
			// PHP drops an unselectable stream, then throws on the empty array.
			$ready = 1;
		}
		if ( 0 === $ready ) {
			return false;
		}

		$read_char = self::$readline_read_char ?? static function (): void {
			\readline_callback_read_char();
		};
		$read_char();

		foreach ( $this->queue as $line ) {
			$this->emit_line( $line );
		}
		$delivered   = [] !== $this->queue;
		$this->queue = [];

		if ( $this->readline_eof ) {
			$this->send_eof();
		} elseif ( $delivered ) {
			// Handler auto-removed on delivery; re-install for the next prompt.
			$this->install_handler();
		}

		return true;
	}

	/**
	 * (Re-)install the readline callback handler with the real prompt.
	 *
	 * PHP auto-removes the handler per delivered line, so this runs again on every
	 * delivery. Handing readline the real prompt rather than an empty string is
	 * what gives it the prompt's width: without that, a backspace at an empty
	 * buffer chews back through the prompt text. Marking the prompt on the
	 * TTY_Out is what makes an async reply wipe and redraw around it instead of
	 * writing over it.
	 */
	private function install_handler(): void {
		$install = self::$readline_handler_install ?? static function ( string $prompt, callable $cb ): void {
			\readline_callback_handler_install( $prompt, $cb );
		};
		$install(
			$this->shell->prompt,
			fn ( ?string $line ) => $this->handle_readline_line( $line )
		);
		$this->out->mark_prompt_displayed();
	}

	/**
	 * Write the prompt for the non-readline path, where nothing redraws it.
	 *
	 * The flag makes this idempotent: `drain_once()` clears it after each
	 * delivered line and calls back here, so the operator gets exactly one prompt
	 * per read however many times the drain ticks in between.
	 */
	private function show_prompt_fallback(): void {
		if ( $this->prompt_displayed ) {
			return;
		}
		// Via TTY_Out so a memory-stream out won't pollute phpunit STDOUT.
		$this->out->write_prompt( $this->shell->prompt );
		$this->prompt_displayed = true;
	}

	/**
	 * Wire tab-completion: register the readline completion callback against the
	 * live candidate cache. readline's completion function receives the word and
	 * its character offset; offset 0 is the first token (command verbs), anything
	 * else an argument (nodes). readline performs the LCP and the listing from the
	 * array we return.
	 *
	 * The caller gates this behind the same TTY and `function_exists` checks as
	 * the readline handler, so both arrive together. The seam lets tests capture
	 * the registration without a TTY.
	 */
	private function install_completion(): void {
		$register = self::$readline_completion_register ?? static function ( callable $cb ): void {
			\readline_completion_function( $cb );
		};
		$register(
			function ( string $word, int $index ): array {
				// Refresh cache for the NEXT Tab (async reply = one-Tab-stale).
				$this->send_completion_queries();
				return $this->complete( $word, $index );
			}
		);
	}

	/**
	 * Send both completion queries through the sink (the Shell) so they ride the
	 * same Command_Interpreter path as any typed command. The replies land
	 * asynchronously and update the cache for the NEXT Tab — completion is thus
	 * one keystroke stale, which an interactive REPL can afford and a synchronous
	 * round trip inside the completion callback could not.
	 */
	public function send_completion_queries(): void {
		if ( null === $this->sink ) {
			return;
		}
		$this->sink->fill( $this->build_completion_query( 'help' ) );
		$this->sink->fill( $this->build_completion_query( 'ls' ) );
	}

	/**
	 * Build the query line that asks for candidates: `help` for verbs, `ls` for
	 * node names.
	 *
	 * The query is REPL input, not a finished command. It goes into the Shell as a
	 * TM_BYTESTREAM, and the Shell parses, stamps, signs and routes it exactly as
	 * it does a line the operator typed — to the session's cwd, so candidates come
	 * from the graph the prompt is pointing at, and FROM the reply path this
	 * session's Dumper filters on. KEY is the one field minted here: the Shell
	 * copies it onto the command it parses out, and `KEY='completion'` makes the
	 * interpreter's `help` and `list_nodes` verbs answer with a bare
	 * newline-separated candidate list, no headers and no column flags.
	 *
	 * @param string $verb Either 'help' (command candidates) or 'ls' (node candidates).
	 * @return array<int,mixed> The TM_BYTESTREAM Message to fill into the Shell.
	 */
	public function build_completion_query( string $verb ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]   = 'completion';
		$message[ Message::VALUE ] = $verb;
		return $message;
	}

	/**
	 * Return cached candidates whose prefix matches $word. The FIRST token on the
	 * line (index 0) completes against command verbs; later tokens (arguments)
	 * complete against node names. readline does the LCP and the listing from the
	 * array returned here.
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

	/**
	 * Take one line from readline: null means end of input, anything else is
	 * queued for the next drain. Public so tests can drive it without a TTY.
	 *
	 * Recording rather than emitting is what keeps the order readable. readline
	 * calls this from inside `readline_callback_read_char()`, and `drain_once()`
	 * owns what follows a line — emit, then either the EOF marker or the handler
	 * re-install — so that sequence lives in one place instead of straddling a
	 * callback. Clearing the TTY_Out flag marks the prompt gone: readline consumed
	 * the line, and what the terminal now shows is the operator's own echo.
	 *
	 * @param string|null $line The line readline delivered, or null at end of input.
	 */
	public function handle_readline_line( ?string $line ): void {
		if ( null === $line ) {
			$this->readline_eof = true;
			return;
		}
		if ( '' !== $line && \function_exists( 'readline_add_history' ) ) {
			\readline_add_history( $line );
		}
		$this->queue[]              = $line;
		$this->out->prompt_displayed = false;
	}

	/**
	 * Ingest a completion reply into the cache. Returns true (consumed) only for
	 * KEY='completion' command responses; the Dumper drops what this consumes, so
	 * candidate lists never reach the terminal. A `help` reply fills the command
	 * cache and every other one — `ls` and its canonical `list_nodes` — fills the
	 * node cache. Each ingest REPLACES its list rather than merging, because nodes
	 * come and go and a merge would keep offering names that are gone.
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
		$name        = Core::as_string( $raw_name );
		$payload     = Core::as_string( $raw_payload );
		$list        = '' === $payload ? [] : \explode( "\n", $payload );

		if ( 'help' === $name ) {
			$this->command_candidates = $list;
		} else {
			// `ls` and its canonical `list_nodes` both fill the node cache.
			$this->node_candidates = $list;
		}
		return true;
	}

	/**
	 * Test/inspection accessor for the command-verb cache.
	 *
	 * @api Read only by tests / REPL inspection; production reads the private field directly.
	 * @return array<int,string>
	 */
	public function command_candidates(): array {
		return $this->command_candidates;
	}

	/**
	 * Test/inspection accessor for the node-name cache.
	 *
	 * @api Read only by tests / REPL inspection; production reads the private field directly.
	 * @return array<int,string>
	 */
	public function node_candidates(): array {
		return $this->node_candidates;
	}

	/**
	 * Schema behind `help TTY_In`. `Hidden` keeps it out of the console palette:
	 * `wp nodes cli` builds this node in PHP, handing it a Shell and a writer no
	 * topology line can name.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Standard input for CLI REPL.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}

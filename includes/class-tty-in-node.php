<?php
/**
 * TTY_In: readline/completion/prompt stdin reader for `wp nodes cli`, atop Stdin_Node.
 *
 * Sinks into the Shell: typed lines parse into commands, stdin EOF round-trips a
 * TM_EOF through the shell, and tab-completion candidates are cached from
 * `help`/`ls` completion replies. It reuses the base Stdin_Node fgets/readline
 * drain as-is; because its sink IS the Shell, the base's `$this->sink->fill()`
 * already drives the shell — no emit overrides needed. The `$shell` ref is kept
 * only to read the live prompt.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

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
	private bool $has_readline;

	/** @var array<int,string> Cached node-name candidates (from `ls` KEY=completion). */
	private array $node_candidates = [];
	private TTY_Out_Node $out;
	private bool $prompt_displayed = false;
	/** @var array<int,string> Lines delivered by the readline callback, drained per fire(). */
	private array $queue = [];
	private bool $readline_eof = false;

	private Shell_Node $shell;
	private bool $show_prompts;

	/**
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
			// NB: the cache seed (send_completion_queries) is deferred to run_repl, AFTER
			// the Dumper's completion_sink is wired — else the seed replies round-trip
			// inline here (fill is synchronous) with no intercept and dump to the terminal.
		} elseif ( $show_prompts ) {
			$this->show_prompt_fallback();
		}
	}

	/**
	 * Drain one cycle: readline mode reads a char + drains the delivered queue;
	 * otherwise the base fgets drain. Either way the base emit primitives fill the
	 * sink (the Shell). Returns true if a line was delivered.
	 */
	protected function drain_once(): bool {
		if ( ! $this->has_readline ) {
			$delivered = parent::drain_once();
			if ( $delivered && $this->show_prompts ) {
				// Force a fresh prompt after each processed line (reader parity).
				$this->prompt_displayed = false;
				$this->show_prompt_fallback();
			}
			return $delivered;
		}

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
		$this->out->mark_prompt_displayed();
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
		$this->queue[]              = $line;
		$this->out->prompt_displayed = false;
	}

	private function show_prompt_fallback(): void {
		if ( $this->prompt_displayed ) {
			return;
		}
		// Routed through TTY_Out so a memory-stream out doesn't pollute phpunit's STDOUT.
		$this->out->write_prompt( $this->shell->prompt );
		$this->prompt_displayed = true;
	}

	/**
	 * Wire tab-completion: register the readline completion callback against the
	 * live candidate cache. readline's completion function receives the word + its
	 * character offset; offset 0 = first token (command verbs), else an argument
	 * (nodes). readline performs the LCP + listing from the array we return.
	 *
	 * Gated by the caller behind the same TTY / function_exists checks as the
	 * readline handler; the seam lets tests capture the registration without a TTY.
	 */
	private function install_completion(): void {
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
	 * Send both completion queries through the sink (the Shell) so they ride the
	 * same CommandInterpreter path as any typed command. The replies land
	 * asynchronously and update the cache for the NEXT Tab — completion is
	 * thus one keystroke stale, which is acceptable for an interactive REPL.
	 */
	public function send_completion_queries(): void {
		if ( null === $this->sink ) {
			return;
		}
		$this->sink->fill( $this->build_completion_query( 'help' ) );
		$this->sink->fill( $this->build_completion_query( 'ls' ) );
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
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]   = 'completion';
		$message[ Message::VALUE ] = $verb;
		return $message;
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

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Standard input for CLI REPL.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}

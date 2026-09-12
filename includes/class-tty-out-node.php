<?php
/**
 * TTY_Out: the terminal writer for `wp nodes cli`, keeping asynchronous output
 * off the line the operator is typing on.
 *
 * A REPL session usually has a prompt on screen, and a cursor part-way through
 * a command, when a reply, a tailed log line or a worker's push arrives.
 * Written straight out, that text lands on top of the prompt. Every write on a
 * live terminal therefore wipes the current line, prints the text, and
 * re-issues the prompt behind it.
 *
 * The redraw is confined to a session that has a prompt to protect. A stream
 * that is not a terminal, a graph with no Shell to read the prompt from, and a
 * screen with no prompt on it each fall through to `Stdout_Node`'s plain
 * write, which is what keeps ANSI escapes out of `wp nodes cli < script | grep`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Prompt-aware terminal writer — `make_node TTY_Out <name>`. The REPL graph
 * wires one as `_stdout` and points the Dumper's target at it, and hands the
 * same instance to `TTY_In_Node`, which draws its prompts through it.
 */
class TTY_Out_Node extends Stdout_Node {

	/** Carriage return plus erase-line: leaves the cursor at column 0 on a blank line. */
	private const ANSI_CR_CLEAR_LINE  = "\r\033[2K";

	/** Put the cursor back where ANSI_SAVE_CURSOR marked it, once the redraw is done. */
	private const ANSI_RESTORE_CURSOR = "\033[u";

	/** Remember where the operator was typing, before the redraw erases that line. */
	private const ANSI_SAVE_CURSOR    = "\033[s";

	/**
	 * Whether a prompt is on screen, and so whether the next write has to wipe
	 * and redraw one. Public because `TTY_In_Node::emit_line()` clears it
	 * directly as it delivers a submitted line: the terminal echoed that line's
	 * newline, so the prompt is spent, and the reply the sink writes inside that
	 * same dispatch must not redraw it.
	 */
	public bool $prompt_displayed = false;

	/**
	 * Whether readline is driving the line editor rather than the `fgets`
	 * fallback. Readline keeps its own model of what is on screen, so the
	 * redraw reprints the prompt itself instead of calling
	 * `readline_redisplay()`, which flips the display into incremental search.
	 */
	private bool $readline_mode = false;

	/**
	 * The Shell whose LIVE prompt every redraw reads. Null in a graph without
	 * one, which leaves no prompt to re-issue and sends every write down the
	 * plain parent path.
	 *
	 * The prompt is read per write rather than copied at wiring time because
	 * `cd`, a held quote or brace continuation, and a `prompt` reply from an
	 * attached worker each rewrite `Shell_Node::$prompt`. A copy would redraw
	 * the prompt of a worker the session is no longer attached to.
	 */
	private ?Shell_Node $shell = null;

	/**
	 * Point the writer at the Shell it reads the live prompt from. Wired after
	 * construction because `CLI_Command::build_repl_graph()` mounts this writer
	 * before the Shell exists.
	 *
	 * @param Shell_Node $shell The REPL's parser, whose prompt each redraw reads.
	 */
	public function set_shell( Shell_Node $shell ): void {
		$this->shell = $shell;
	}

	/**
	 * Select the redraw that matches the line editor the cli resolved: readline
	 * when stdin is a terminal and the extension is loaded, the `fgets` fallback
	 * otherwise.
	 *
	 * @param bool $on True when readline drives the line editor.
	 */
	public function set_readline_mode( bool $on ): void {
		$this->readline_mode = $on;
	}

	/**
	 * Record that a prompt reached the screen by a path other than
	 * `write_prompt()`, so the next async write wipes and redraws it.
	 * `TTY_In_Node` calls this after each readline handler install, since that
	 * install is what puts readline's own prompt on screen.
	 */
	public function mark_prompt_displayed(): void {
		$this->prompt_displayed = true;
	}

	/**
	 * Write a prompt to the owned stream, bypassing the `write()` seam: a prompt
	 * is what a redraw restores, so putting one through the redraw would erase
	 * the line it is being drawn on.
	 *
	 * `TTY_In_Node`'s no-readline fallback draws its prompts through here rather
	 * than through an `fwrite` of its own, so a test holding this node's stream
	 * keeps prompts out of phpunit's output.
	 *
	 * The prompt is untrusted text: `Dumper_Node::fill()` writes
	 * `Shell_Node::$prompt` from an attached worker's `prompt` response, and
	 * `prompt_is_trusted()` weighs only WHO sent it, never what it says. So it
	 * is rendered here like any other payload, which the bypass would otherwise
	 * skip.
	 *
	 * It is rendered BARE even on a terminal, as it is at every other site that
	 * draws this prompt. Reverse video is how the renderer calls out an anomaly
	 * inside data the operator is reading; the prompt is chrome, redrawn on
	 * every async write, so highlighting there is constant noise rather than a
	 * signal. One prompt, one appearance, and that appearance is plain.
	 *
	 * @param string $prompt Prompt text, control characters not yet rendered.
	 */
	public function write_prompt( string $prompt ): void {
		$this->write_all( Core::terminal_safe( $prompt, false ) );
		$this->prompt_displayed = true;
	}

	/**
	 * Write one message, wiping and redrawing the prompt when a live session has
	 * one on screen.
	 *
	 * Three conditions have to hold together: the stream is a terminal, a prompt
	 * is on screen, and a Shell is wired to read that prompt from. Any one of
	 * them missing means there is nothing to protect, and the text goes out
	 * through the parent's plain `fwrite`.
	 *
	 * The prompt is re-issued only when the text ends in a newline. `print foo`
	 * sends no terminator and leaves the cursor on the text's own line, where a
	 * prompt drawn behind it would sit mid-line. Tachikoma's `Dumper.pm` gates
	 * `update_prompt` on the same trailing newline.
	 *
	 * The payload and the re-issued prompt are both rendered on the way in, and
	 * the escape sandwich is composed around them afterwards: the ANSI this node
	 * writes deliberately is its own, and nothing arriving here may add to it.
	 * The plain path renders in `parent::write()` instead, so neither text is
	 * rendered twice. The payload keeps reverse video on a terminal; the prompt
	 * goes bare, matching what `write_prompt()` and readline's own install put
	 * on screen, so a forced redisplay cannot make the prompt flicker between
	 * two looks.
	 *
	 * @param string $text Bytes to write, control characters not yet rendered.
	 */
	protected function write( string $text ): void {
		if ( ! $this->stdout_is_tty || ! $this->prompt_displayed || null === $this->shell ) {
			parent::write( $text );
			return;
		}

		$prompt = '';
		if ( \str_ends_with( $text, "\n" ) ) {
			 $prompt = Core::terminal_safe( $this->shell->prompt, false );
		}
		$text = Core::terminal_safe( $text, true );

		if ( $this->readline_mode ) {
			// Reprint the prompt rather than calling readline_redisplay().
			$this->write_all( self::ANSI_CR_CLEAR_LINE . $text . $prompt );
			return;
		}

		$this->write_all(
			self::ANSI_SAVE_CURSOR
				. self::ANSI_CR_CLEAR_LINE
				. $text
				. $prompt
				. self::ANSI_RESTORE_CURSOR
		);
	}

	/**
	 * Console manifest. `Hidden` keeps the class out of the palette and the
	 * Inspector: the cli wires its own writer, and a canvas has no terminal to
	 * write to. `has_target` is false because `fill()` writes rather than
	 * forwards, so the canvas draws no out-port.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Prompt-aware terminal writer — Stdout_Node plus readline/ANSI redraw.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}

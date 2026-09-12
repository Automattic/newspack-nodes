<?php
/**
 * Stdout: the bare terminal sink. It coerces a message VALUE to a string,
 * renders its control characters visible, and fwrites it to the stream it owns,
 * adding nothing else — no newline, no framing, no branch on message type — so
 * whatever a Dumper or an interpreter reply already rendered reaches the
 * terminal as the text it is, never as instructions to the terminal.
 *
 * Two paths, and which one a caller takes is the whole security boundary here.
 * Everything arriving as a MESSAGE — a Dumper's line, an interpreter reply, a
 * tailed log, `wp nodes reqgrep` — goes through `fill()` and is rendered, which
 * is the default and needs no opting in. `write_raw()` is the single bypass,
 * for a caller composing a control sequence deliberately, and the only one in
 * the tree is `Shell_Node`'s `clear` builtin.
 *
 * Rendering belongs upstream, which is why there is no type dispatch here: a
 * scalar VALUE prints the same whether it arrives as TM_BYTESTREAM or
 * TM_STRUCT, and a non-scalar one reads as the empty string through
 * `Core::as_string()` and writes nothing rather than the useless word `Array`.
 * Put a Dumper in front to turn a struct into a line.
 *
 * The stream and the whole-string write on it are all this file owns for
 * both terminal writers: `TTY_Out_Node` extends it with readline and ANSI
 * redraw and inherits the coercion and the write loop unchanged.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Terminal sink — `make_node Stdout <name>`. The REPL graph wires its
 * `TTY_Out_Node` subclass as `_stdout` and points the Dumper's target at it.
 */
class Stdout_Node extends Node {

	/**
	 * Microseconds one refused write waits for the terminal to drain before it
	 * is retried. The wait is a ceiling: writability ends it early.
	 */
	private const WRITE_WAIT_US = 100000;

	/**
	 * The stream every write lands on, owned for the node's lifetime. Private
	 * because `write_all()` is the only way onto it: `TTY_Out_Node` composes
	 * its redraw and hands the bytes here.
	 *
	 * @var resource
	 */
	private $stdout;

	/**
	 * Whether the owned stream is a real terminal, settled once at construction
	 * and read by every write. It decides ANSI alone: a rendered control
	 * character is reverse-videoed on a terminal and bare in a pipe, a file or a
	 * test capture. `TTY_Out_Node` reads it for its redraw as well.
	 */
	protected bool $stdout_is_tty;

	/**
	 * Take ownership of the output stream and settle the TTY question once.
	 *
	 * Production reads `posix_isatty()`. Tests pass `$force_tty` because a
	 * `php://memory` stream is never a terminal, and forcing it true is the only
	 * way to exercise the terminal paths against a buffer the test can read back.
	 *
	 * @param resource|null $stdout    Defaults to STDOUT. Pass php://memory for tests.
	 * @param bool|null     $force_tty Override the posix_isatty() detection; null detects.
	 */
	public function __construct( $stdout = null, ?bool $force_tty = null ) {
		parent::__construct();
		$this->stdout = $stdout ?? \STDOUT;

		if ( null !== $force_tty ) {
			$this->stdout_is_tty = $force_tty;
			return;
		}
		$this->stdout_is_tty = \is_resource( $this->stdout )
			&& \function_exists( 'posix_isatty' )
			&& @\posix_isatty( $this->stdout );
	}

	/**
	 * Write the message VALUE and stop. Every message counts, including one
	 * whose VALUE renders to nothing, so `ls -c` reports what ARRIVED.
	 *
	 * This is a terminal and never chains to `parent::fill()`: there is nowhere
	 * to forward, and the sink the REPL graph wires is only the convention that
	 * every node sinks into `_command_interpreter`. The write's disposition is
	 * unobservable to the producer, which is what ADR-13 buys.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		$this->write( Core::as_string( $message[ Message::VALUE ] ) );
	}

	/**
	 * Write seam: the one write on the data path, the one place a control
	 * character in a payload is rendered visible, and the only call a subclass
	 * has to intercept. `TTY_Out_Node` overrides it to wipe and redraw around a
	 * live prompt, which is why the coercion and the counter sit in `fill()` —
	 * an override inherits both instead of reimplementing them.
	 *
	 * @param string $text Bytes to write, control characters not yet rendered.
	 */
	protected function write( string $text ): void {
		$this->write_all( Core::terminal_safe( $text, $this->stdout_is_tty ) );
	}

	/**
	 * Put bytes on the stream verbatim, rendering nothing and framing nothing.
	 *
	 * The one bypass around `write()`, for a caller that MEANS its control
	 * bytes: `Shell_Node`'s `clear` builtin sends an erase-display sequence, and
	 * rendered it would print `<1B>[2J<1B>[H` instead of clearing the screen.
	 * Nothing on the message path reaches here — a caller has to name it — and
	 * `TTY_Out_Node` inherits it unchanged, so a raw write skips the prompt
	 * redraw as well as the rendering.
	 *
	 * @param string $text Trusted bytes, written exactly as given.
	 */
	public function write_raw( string $text ): void {
		$this->write_all( $text );
	}

	/**
	 * Put every byte of $bytes on the owned stream, waiting out a full
	 * terminal buffer rather than dropping what it refused.
	 *
	 * On a pty, fd 0 and fd 1 share one open file description, so the
	 * O_NONBLOCK that `Stdin_Node` sets on STDIN lands on STDOUT too, and one
	 * `fwrite` there returns the short count the pty buffer took — 12KB of a
	 * long reply, the rest silently gone. A refused write here waits for the
	 * stream to become writable, then offers the remainder again. It gives up
	 * only when the write itself fails, because a terminal refuses a write
	 * while its reader catches up, not because it is full for good; a closed
	 * handle throws at `fwrite` before this loop sees it, as it always has.
	 * The wait's own result is not read: `stream_select()`
	 * returns false on EINTR as readily as on a bad descriptor, and
	 * `Event_Framework` installs signal handlers, so a false there means
	 * retry, and the descriptor going bad surfaces on the next `fwrite`.
	 *
	 * `File_Writer::write_all()` is the segment writer's loop, not this one:
	 * it spends a five-refusal budget with no wait, then reports a short count
	 * for `Partition_Node` to quarantine, which is right for a full disk and
	 * wrong for a terminal, where there is nothing to quarantine and the
	 * refusal clears on its own.
	 *
	 * @param string $bytes Bytes to write, already rendered where they should be.
	 */
	protected function write_all( string $bytes ): void {
		$read   = [];
		$except = [];
		while ( '' !== $bytes ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			$written = \fwrite( $this->stdout, $bytes );
			if ( false === $written ) {
				return;
			}
			if ( 0 === $written ) {
				$write = [ $this->stdout ];
				@\stream_select( $read, $write, $except, 0, self::WRITE_WAIT_US );
				continue;
			}
			$bytes = \substr( $bytes, $written );
		}
	}

	/**
	 * Console manifest. `Hidden` drops the class from the catalog, so it
	 * reaches neither the palette nor the Inspector: a terminal writer is wired
	 * by the cli or a topology line, never dragged onto a canvas. `has_target`
	 * is false because `fill()` writes rather than forwards, so the canvas
	 * draws no out-port; the omitted `accepts_fill` defaults to true, which is
	 * the in-port.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Bare terminal sink — fwrites a message VALUE to its stream.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}

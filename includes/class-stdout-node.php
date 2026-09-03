<?php
/**
 * Stdout: the bare terminal sink. It coerces a message VALUE to a string and
 * fwrites it to the stream it owns, adding nothing — no newline, no framing,
 * no branch on message type — so whatever a Dumper or an interpreter reply
 * already rendered reaches the terminal byte for byte.
 *
 * Rendering belongs upstream, which is why there is no type dispatch here: a
 * scalar VALUE prints the same whether it arrives as TM_BYTESTREAM or
 * TM_STRUCT, and a non-scalar one reads as the empty string through
 * `Core::as_string()` and writes nothing rather than the useless word `Array`.
 * Put a Dumper in front to turn a struct into a line.
 *
 * The stream and the single `fwrite` on it are all this file owns for both
 * terminal writers: `TTY_Out_Node` extends it with readline and ANSI redraw
 * and inherits the coercion unchanged.
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
	 * The stream every write lands on, owned for the node's lifetime.
	 * Protected rather than private because `TTY_Out_Node` writes its prompts
	 * straight to it, outside the `write()` seam.
	 *
	 * @var resource
	 */
	protected $stdout;

	/**
	 * Take ownership of the output stream.
	 *
	 * @param resource|null $stdout Defaults to STDOUT. Pass php://memory for tests.
	 */
	public function __construct( $stdout = null ) {
		parent::__construct();
		$this->stdout = $stdout ?? \STDOUT;
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
	 * Write seam: the one `fwrite` on the data path, and the only call a
	 * subclass has to intercept. `TTY_Out_Node` overrides it to wipe and redraw
	 * around a live prompt, which is why the coercion and the counter sit in
	 * `fill()` — an override inherits both instead of reimplementing them.
	 *
	 * @param string $text Bytes to write, exactly as they should appear.
	 */
	protected function write( string $text ): void {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $this->stdout, $text );
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

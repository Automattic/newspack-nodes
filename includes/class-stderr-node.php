<?php
/**
 * Stderr: the diagnostic sink. It writes a TM_BYTESTREAM VALUE through the
 * node's stderr chain and forwards nothing, so a debug tap reaches the
 * diagnostic log without polluting the STDOUT data path. Splice one on the end
 * of `Tee → Dumper → Grep`.
 *
 * `Node::stderr()` tags the line with this node's name and hands it to
 * `Core::stderr()`, which stamps the process midfix, keeps a timestamped copy
 * in the 100-line `dmesg` ring the REPL dumps, fires the
 * `newspack_nodes/stderr` action, and calls `error_log()` beside the REPL, SSE
 * or `_output` node when one of those is registered. One write therefore lands
 * on every diagnostic surface at once, which is what a tap wants and what a
 * data path must never do.
 *
 * Only TM_BYTESTREAM is written, so put a Dumper in front to render anything
 * structured into a line first: `Core::as_string()` reads an array VALUE as
 * the empty string, and `Node::stderr()` drops that.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Stderr node — `make_node Stderr <name>`.
 */
class Stderr_Node extends Node {

	/**
	 * Write a bytestream line to the diagnostic log and drop every other
	 * message. The bitwise test wants a real int, so a TYPE arriving as a
	 * numeric string falls to the drop. The drop is silent: `fill()` returns
	 * nothing, and a producer cannot observe what became of what it sent
	 * (ADR-13).
	 *
	 * The count runs before the type test, so `ls -c` and `dump_metadata`
	 * report what ARRIVED rather than what was written — a tap swallowing
	 * struct traffic would otherwise read as a dead route.
	 *
	 * This is a terminal and never chains to `parent::fill()`, which forwards
	 * to a sink this node is not required to have.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];
		if ( \is_int( $type ) && ( $type & Message::TM_BYTESTREAM ) ) {
			$this->stderr( Core::as_string( $message[ Message::VALUE ] ) );
		}
	}

	/**
	 * Console-palette entry: an I/O terminal taking no positional arguments.
	 * Nothing leaves it, so the canvas draws no out-port.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'I/O',
			'description' => 'Diagnostic sink — writes a TM_BYTESTREAM VALUE to the process stderr log (node-tagged, into dmesg / debug.log / stderr). Non-bytestream messages are dropped.',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}

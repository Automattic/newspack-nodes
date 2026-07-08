<?php
/**
 * Stderr: bare diagnostic sink — routes a TM_BYTESTREAM VALUE through the node's
 * stderr chain (Node::stderr -> Core::stderr: node-name midfix, dmesg ring,
 * error_log, debug.log, the real stderr write).
 *
 * Splice one on the end of a debug tap (Tee -> Dumper -> Grep -> Stderr) so the
 * rendered/filtered lines land in the diagnostic log without polluting the
 * STDOUT data path. Only TM_BYTESTREAM is written — put a Dumper in front to
 * render anything structured into a line first.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Stderr_Node extends Node {

	public function fill( array $message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];
		if ( \is_int( $type ) && ( $type & Message::TM_BYTESTREAM ) ) {
			$this->stderr( Core::as_string( $message[ Message::VALUE ] ) );
		}
	}

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

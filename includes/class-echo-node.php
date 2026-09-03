<?php
/**
 * Echo: the re-addressing node. It rewrites a message's TO and touches nothing
 * else, so a graph re-routes traffic by splicing a node in rather than by
 * rewiring sinks (ADR-7). Ported from Tachikoma's `Nodes::Echo`.
 *
 * `target` and the incoming TO pick one of four cases. A target plus a TO
 * prefixes the path (`target/TO`), and because Router peels only the head
 * segment the original address still routes onward behind it. No target and no
 * TO returns the message to its sender (TO=FROM), which is what makes a bare
 * Echo a ping responder. The other two fall through to `Node::fill`: a TO with
 * no target passes through untouched, and a target with an empty TO takes the
 * base stamp, so the message goes to the target rather than back to FROM.
 *
 * A TM_ERROR with an empty TO is dropped instead of bounced. Returning it would
 * land an error trail on a producer that never asked for one.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Echo_Node extends Node {

	/**
	 * Re-address the message, then forward it to the sink unchanged.
	 *
	 * TYPE is read leniently, because a message decoded off the wire can carry it
	 * as a numeric string and the error drop must not depend on the producer's
	 * JSON typing. The test is bitwise rather than the equality `Echo.pm` uses:
	 * the command interpreter mints its refusals as `TM_COMMAND|TM_ERROR`, and an
	 * exact match would let the substrate's commonest error shape bounce.
	 *
	 * A non-string target is Tee's fan-out form, which composes no path, so Echo
	 * reads it as no target and an empty TO still returns to sender.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		$type   = Core::as_int( $message[ Message::TYPE ] );
		$to     = Core::as_string( $message[ Message::TO ] );
		$target = $this->target;
		if ( ( $type & Message::TM_ERROR ) && '' === $to ) {
			return;
		}
		if ( \is_string( $target ) && '' !== $target && '' !== $to ) {
			$message[ Message::TO ] = $target . '/' . $to;
		} elseif ( ( ! \is_string( $target ) || '' === $target ) && '' === $to ) {
			$message[ Message::TO ] = $message[ Message::FROM ];
		}
		parent::fill( $message );
	}

	/**
	 * Console-palette entry: a routing primitive with no positional arguments.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Re-addresses messages: target/TO, bounce, or pass-through.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}

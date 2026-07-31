<?php
/**
 * Null: the black hole. Modeled on Tachikoma's `Nodes::Null`, whose `fill()`
 * counts and returns.
 *
 * It earns its place as a DESTINATION. A node that must declare a target — an
 * `HTTP_Out` whose wire-inbound clause is only armed once one is set — needs
 * somewhere to point when the traffic itself is unwanted. The arm worth having
 * there is the refusal of a non-response the remote addressed at our graph;
 * whatever the other arm stamps has to land somewhere, and landing it back on a
 * relay node would send it straight out again.
 *
 * Tachikoma's Null is also a load generator (a timer that fires cached
 * TM_PERSIST payloads at `max_unanswered`). That half is absent here: we removed
 * TM_PERSIST (ADR-3), and the acknowledgement window it paces against with it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Null_Node extends Node {

	/**
	 * Swallow the message. Counted, so `ls` still shows what a Null absorbed —
	 * a silent black hole is indistinguishable from a broken route.
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
	}

	/** @return array<string, mixed> */
	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'Discards everything sent to it. A destination for traffic that must go somewhere and do nothing.',
			'arguments'   => [],
			'has_target'  => false,
		];
	}
}

<?php
/**
 * Null: the black hole. Modeled on Tachikoma's `Nodes::Null`, whose `fill()`
 * counts and returns.
 *
 * It earns its place as a DESTINATION. `HTTP_Out` arms its wire-inbound clause
 * only once a target is set; with none, neither arm engages and a remote may
 * address any node in our graph. Setting one buys that refusal, and the other
 * arm then stamps the remote's unaddressed output for the target, so the target
 * has to be a node that swallows what lands on it. Aiming it at the relay that
 * owns the egress — a `Remote_Link_Node` — would send the spoke's own output
 * straight back out.
 *
 * Tachikoma's Null is also a load generator: a timer firing cached TM_PERSIST
 * payloads at `max_unanswered`. That half is absent here, because this
 * substrate carries no TM_PERSIST (ADR-3) and therefore no acknowledgement
 * window to pace against.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Null_Node extends Node {

	/**
	 * Swallow the message. Counted rather than merely dropped, so `ls -c` and
	 * `stats` report what a Null absorbed — a silent black hole is
	 * indistinguishable from a broken route.
	 *
	 * It does not chain to `parent::fill()`, which forwards and demands a wired
	 * sink. A Null terminates, and has to work with nothing downstream of it.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
	}

	/**
	 * Console-palette entry: a terminal taking no positional arguments. Nothing
	 * leaves, so the canvas draws no out-port.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'Discards everything sent to it. A destination for traffic that must go somewhere and do nothing.',
			'arguments'   => [],
			'has_target'  => false,
		];
	}
}

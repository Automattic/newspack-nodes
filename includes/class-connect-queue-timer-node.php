<?php
/**
 * Connect_Queue_Timer_Node — drains the shared connect queue, one per tick.
 *
 * A direct port of Tachikoma's `Nodes::JobSpawnTimer` (`@SPAWN_QUEUE` +
 * `$SPAWN_QUEUE_TIMER` in `Job.pm`): one process-wide timer pops ONE queued
 * closure per fire and removes itself when the queue runs dry, so the node
 * exists only while there is work.
 *
 * What it buys here is the same thing it buys Tachikoma: an aggregator brings
 * up every Remote_Source in one tick, and N simultaneous SSE connects are what
 * a spoke's slot pool answers with HTTP 429. Spread over the queue they arrive
 * one per interval.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Connect_Queue_Timer_Node extends Timer_Node {

	/** Reserved node name; `Remote_Link_Node` mounts exactly one. */
	public const NODE_NAME = Node_Names::CONNECT_TIMER;

	/** Gap between queued connects (ms). One spoke per interval. */
	public const INTERVAL_MS = 500;

	/**
	 * Pop one queued connect and run it; retire when the queue is empty.
	 *
	 * @api Dynamic entrypoint (Timer_Node::fire_cb).
	 */
	public function fire(): void {
		$connect = Remote_Link_Node::shift_connect_queue();
		if ( null === $connect ) {
			$this->remove_node();
			return;
		}
		$connect();
	}

	/** @api Resolved by make_node; hidden from the palette (mounted, not dropped). */
	public static function node_schema(): array {
		return [
			'category'    => 'Control',
			'description' => 'Drains the shared Remote_Link connect queue, one connect per tick.',
			'hidden'      => true,
			'has_target'  => false,
			'arguments'   => [],
			'commands'    => [],
			'requests'    => [],
		];
	}
}

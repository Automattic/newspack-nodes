<?php
/**
 * Connect_Queue_Timer_Node — drains the shared connect queue, one per fire.
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

/**
 * `Remote_Link_Node::queue_connect()` constructs, names, sinks and arms this
 * node itself — it appears in no TSL and answers to no `make_node`. The sink is
 * part of that mount rather than an emit path: `Timer_Node::fire_cb()` returns
 * before `fire()` when the sink is null, so a timer mounted without one holds
 * the queue forever and nothing ever connects.
 */
class Connect_Queue_Timer_Node extends Timer_Node {

	/**
	 * Reserved node name; `Remote_Link_Node` mounts exactly one.
	 *
	 * `Node_Names::SESSION_SCAFFOLDING` carries it, so `dump_config` omits the
	 * node and the `destroy` verb refuses it. Retiring on a dry queue is the
	 * only thing that takes it down.
	 */
	public const NODE_NAME = Node_Names::CONNECT_TIMER;

	/**
	 * Gap between queued connects (ms). One spoke per interval.
	 *
	 * Under `Router_Node::DEFAULT_TICK_MS`, so `set_timer()` gives the node its
	 * own Event_Framework slot. Raising it to 1000 or more moves it onto the
	 * Router hitchhike, which fires at one-second granularity.
	 */
	public const INTERVAL_MS = 500;

	/**
	 * Pop one queued connect and run it; retire when the queue is empty.
	 *
	 * Retiring costs nothing to undo — `Remote_Link_Node::queue_connect()`
	 * remounts the timer on the next push — and it spares an otherwise idle
	 * process a wakeup every `INTERVAL_MS`.
	 *
	 * The override replaces `Timer_Node::fire()` whole: no heartbeat message
	 * reaches the sink and no `FIRE` event is notified.
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

	/**
	 * Palette and canvas manifest.
	 *
	 * `hidden` keeps the node off both surfaces. Every `Remote_Link_Node` shares
	 * this one timer, so it has no patron to mark it as plumbing, and the flag
	 * is the only signal `Classes_CI_Node`'s palette scan and the interpreter's
	 * `dump_metadata` canvas listing can read. It declares no arguments and does
	 * not merge the parent schema: `Timer_Node` declares an `interval_ms`
	 * positional and a `FIRE` registration, and this class replaces both — the
	 * cadence is the `INTERVAL_MS` constant, and `fire()` emits nothing.
	 *
	 * @api Dynamic entrypoint.
	 * @return array<string,mixed>
	 */
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

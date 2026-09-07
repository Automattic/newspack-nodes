<?php
/**
 * Connect_Queue_Timer_Node — drains the shared connect queue, one per fire.
 *
 * A direct port of Tachikoma's `Nodes::JobSpawnTimer` (`@SPAWN_QUEUE` and
 * `$SPAWN_QUEUE_TIMER` in `Job.pm`): one process-wide timer pops ONE queued
 * closure per fire and removes itself when the queue runs dry, so the node
 * exists only while there is work.
 *
 * The payoff is Tachikoma's: an aggregator brings every `Remote_Source_Node`
 * up in one tick, and a spoke whose `SSE_Slot_Pool` has no free slot answers
 * each connect with HTTP 429. Spread over the queue, they arrive one per
 * `INTERVAL_MS`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * `Remote_Link_Node::queue_connect()` constructs, names, sinks and arms this
 * node itself: no TSL declares it and no topology builds it with `make_node`.
 * The sink it receives is `_command_interpreter`, part of that mount rather
 * than an emit path, because `Timer_Node::fire_cb()` returns before `fire()`
 * when the sink is null, so a timer mounted without one holds the queue
 * forever and nothing ever connects.
 */
class Connect_Queue_Timer_Node extends Timer_Node {

	/**
	 * Reserved node name; `Remote_Link_Node` mounts exactly one.
	 *
	 * `Node_Names::SESSION_SCAFFOLDING` carries it, so the `dump_config` verb
	 * omits the node and the `remove_node` verb refuses it. Inside a live graph,
	 * retiring on a dry queue is the only thing that takes it down.
	 */
	public const NODE_NAME = Node_Names::CONNECT_TIMER;

	/**
	 * Gap between queued connects, in milliseconds.
	 *
	 * Below the Router's tick, which `Worker_Base` arms at
	 * `Router_Node::DEFAULT_TICK_MS` (1000), so `set_timer()` gives the node its
	 * own Event_Framework slot. Raising it to that tick or beyond moves it onto
	 * the Router hitchhike, which fires no finer than the tick itself.
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
	 * `dump_metadata` canvas listing can read. What survives the flag is `help
	 * Connect_Queue_Timer`, which renders the schema of any class the shell
	 * resolves.
	 *
	 * It declares no arguments and does not merge the parent schema:
	 * `Timer_Node` declares an `interval_ms` positional and a `FIRE`
	 * registration, and this class replaces both. The cadence is the
	 * `INTERVAL_MS` constant, and `fire()` emits nothing, so `has_target` is
	 * false and the omitted `registrations` leave `Node::seed_registrations()`
	 * an empty allow-list on which `register( 'FIRE' )` throws.
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

<?php
/**
 * Idle_Reporter: a node that can say whether it is holding work.
 *
 * An on-demand worker exits when there is nothing left to do, and only the
 * nodes know that. "No messages arrived" is not the same question: a request
 * that logged its start and then went quiet — a slow external call, a long
 * query — leaves a builder holding an envelope while its consumer sits at EOF.
 * Exiting there abandons a started span for a successor to reconstruct.
 *
 * Opting in is the whole point: `Worker_Base` names no application class, and
 * a graph with no reporter has nothing to measure, so it never idle-exits.
 *
 * The timestamp, rather than a bool, is what `Consumer_Node::idle_since()`
 * already returns and what `SSE_Out_Node` already consumes — so a node that
 * has been quiet since before this process started says so, and the worker
 * needs no streak state of its own to notice.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

interface Idle_Reporter {

	/** Epoch seconds this node went idle; null while it holds work. */
	public function idle_since(): ?float;
}

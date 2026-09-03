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
 * a graph with no reporter has nothing to measure, so it never idle-exits. The
 * scan walks the process registry (`Core::$nodes_by_name`), so a node that
 * never took a name is invisible to it; that is why the anonymous IPC consumer
 * is handed to the scan separately.
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

	/**
	 * When this node last had nothing left to do.
	 *
	 * `Worker_Base::should_continue()` folds every reporter in the graph, so one
	 * null forbids the whole worker's exit. Answer null when the question is
	 * unanswerable, and a timestamp when the node is merely empty: a reader
	 * tailing a log nobody writes is idle, and reporting null there would hold
	 * the process resident through every recycle.
	 *
	 * That scan runs at most once a second, so a `stat` is affordable here.
	 *
	 * @return float|null Epoch seconds this node went idle; null while it holds work.
	 */
	public function idle_since(): ?float;
}

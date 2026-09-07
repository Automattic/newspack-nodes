<?php
/**
 * HTTP_Filter: the per-session gate on attached-worker replies inside an SSE
 * stream process.
 *
 * Every browser tab attached to the same worker consumes that worker's output
 * Partition, so without a gate each tab would receive every other tab's command
 * replies. One stream process serves exactly one session, so its pid names the
 * session.
 *
 * A browser mints a command stamped FROM `_sse:<sse-pid>/<reply-node>`,
 * `HTTP_In` adds the `_output` boundary, and the worker's IPC-input Consumer
 * adds `_repl`. The worker's TO=FROM reply (ADR-7) is therefore addressed
 * `_repl/_output/_sse:<sse-pid>/<reply-node>`, and the worker's Router peels
 * `_repl` on the way into the output Partition. A Consumer in the SSE process
 * reads that record and forwards it through the interpreter into `_router`,
 * which peels the leading `_output` and fills this Node — registered under
 * that name, sinking into the `SSE_Out` egress — with TO set to
 * `_sse:<sse-pid>/<reply-node>`. Matching that head against this process's own
 * `_sse:<pid>` and stripping it leaves the browser-side reply node, `_output`
 * for the console's Dumper, as the TO the client's own router dispatches on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The `_output` boundary of one SSE stream process, bound to that process's
 * pid. `SSE_Out_Node` builds it with `getmypid()`, patrons it to itself so
 * `dump_metadata` and `dump_config` skip the plumbing, then names it `_output`
 * and sinks it into itself; nothing else constructs one.
 */
class HTTP_Filter_Node extends Node {

	/** The stream process's pid; the reply head it accepts is `_sse:<pid>`. */
	private int $own_pid;

	/**
	 * Bind the gate to one stream process.
	 *
	 * @param int $own_pid This process's pid, which the browser echoed back
	 *                     into the command's FROM as `_sse:<pid>`.
	 */
	public function __construct( int $own_pid ) {
		parent::__construct();
		$this->own_pid = $own_pid;
	}

	/**
	 * Forward a reply addressed to this session and drop every other one.
	 *
	 * The counter counts both, so `ls -c` reports what the gate saw rather than
	 * what it passed; a filter with no traffic and a filter dropping all of it
	 * would otherwise show the same row. The drop is silent by contract
	 * (ADR-13) — `fill()` returns nothing, so a producer cannot tell a gated
	 * reply from a delivered one.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws \RuntimeException When no sink is wired.
	 */
	public function fill( array $message ): void {
		$sink = $this->require_sink();
		++$this->counter;
		[ $head, $reply_node ] = Message::split_first( Core::as_string( $message[ Message::TO ] ) );
		if ( Node_Names::SSE . ':' . $this->own_pid !== $head ) {
			return;
		}
		$message[ Message::TO ] = $reply_node;
		$sink->fill( $message );
	}

	/**
	 * Topology console manifest: hidden, with no arguments and no verbs.
	 *
	 * `Hidden` is what keeps it out of the class palette. A TSL `make_node`
	 * line cannot build it either: `make_node` constructs with `new $fqcn()`,
	 * and this constructor requires a pid.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Per-session attached-reply gate; SSE-process equivalent of SSE_Out.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}

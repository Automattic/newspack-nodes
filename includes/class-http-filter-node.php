<?php
/**
 * HTTP_Filter: the per-session gate on attached-worker replies inside an SSE
 * stream process.
 *
 * Every browser tab attached to the same worker consumes that worker's output
 * Partition, so without a gate each tab would receive every other tab's command
 * replies. A stream presents the command session it signs with, and that
 * session's handle names it — across reconnects, where a process pid would
 * name only the one connection that was open when the command left.
 *
 * A browser mints a command stamped FROM `_sse:<handle>/<reply-node>`,
 * `HTTP_In` adds the `_output` boundary, and the worker's IPC-input Consumer
 * adds `_repl`. The worker's TO=FROM reply (ADR-7) is therefore addressed
 * `_repl/_output/_sse:<handle>/<reply-node>`, and the worker's Router peels
 * `_repl` on the way into the output Partition. A Consumer in the SSE process
 * reads that record and forwards it through the interpreter into `_router`,
 * which peels the leading `_output` and fills this Node — registered under
 * that name, sinking into the `SSE_Out` egress — with TO set to
 * `_sse:<handle>/<reply-node>`. Matching that head against this stream's own
 * session and stripping it leaves the browser-side reply node, `_output` for
 * the console's Dumper, as the TO the client's own router dispatches on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The `_output` boundary of one SSE stream, bound to the command session the
 * stream presented. `SSE_Out_Node` builds it with that handle, patrons it to
 * itself so `dump_metadata` and `dump_config` skip the plumbing, then names it
 * `_output` and sinks it into itself; nothing else constructs one.
 */
class HTTP_Filter_Node extends Node {

	/** The reply head this stream accepts, `_sse:<handle>`; null accepts none. */
	private ?string $own_head;

	/**
	 * Bind the gate to one command session.
	 *
	 * @param string|null $session Handle of the session the stream presented, or
	 *                             null for a stream that presented none, whose
	 *                             gate passes no reply at all.
	 */
	public function __construct( ?string $session ) {
		parent::__construct();
		$this->own_head = null === $session ? null : Node_Names::SSE . ':' . $session;
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
		if ( null === $this->own_head || $this->own_head !== $head ) {
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
	 * and this constructor requires a session.
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

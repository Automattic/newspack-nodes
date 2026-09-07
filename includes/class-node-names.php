<?php
/**
 * The reserved node names both runtimes address by literal string.
 *
 * `src/runtime/reserved-node-names.json` is the canonical map and this class is
 * its PHP half; `tests/unit/NodeNamesTest.php` fails when the two diverge. The
 * names are part of the wire, not a local convention: a browser mints a command
 * stamped `FROM = _sse:<pid>/_output`, the worker answers TO=FROM (ADR-7), and
 * every hop between resolves the head of that path against a node registered
 * under one of these strings. Spell one differently on either side and the
 * reply never reaches the node that minted the command.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The reserved names as constants, so no caller spells one as a literal.
 *
 * @api JS-PHP wire constants; the dead-code audit cannot see the JSON half.
 */
final class Node_Names {
	/** Verb dispatch. Every node sinks here, and this sinks into `_router`. */
	public const COMMAND_INTERPRETER = '_command_interpreter';

	/** The Tap between the anonymous Shell and the interpreter, so a session can watch what the Shell sends. */
	public const CONSOLE_TAP         = '_shell';

	/** Browser-side node publishing the tab-completion candidates a `help`/`ls` reply carries. */
	public const COMPLETION          = '_completion';

	/** Browser-side routing indirection: its `target` holds the current working directory, so every poller addresses `_cwd` and one `cd` re-aims them all. */
	public const CWD                 = '_cwd';

	/** Browser-side node publishing the error, warning and debug line counts the inspector shows. */
	public const DMESG               = '_dmesg';

	/** The `Fleet_Node` every worker mounts to revive its peers (ADR-9). */
	public const FLEET               = '_fleet';

	/** Browser-side timer poking its SSE slot lease on the shared tick; the server checks that lease and never refreshes it. */
	public const HEARTBEAT           = '_heartbeat';

	/** Command egress: the browser backbone's `HttpOutNode` and the second hop of every `egressPath()`; PHP's `HTTP_Out_Node` stamps it into FROM. */
	public const HTTP                = '_http';

	/** Browser-side node publishing the `dump_metadata` graph the canvas paints. */
	public const METADATA            = '_metadata';

	/** The reply boundary. A minter stamps `FROM = _output/<id>`, so the TO=FROM answer lands here. */
	public const OUTPUT              = '_output';

	/** The worker's output IPC Partition, and the FROM its input Consumer stamps, so the TO=FROM reply routes back through it to the attached cli. */
	public const REPL                = '_repl';

	/** Path dispatch: peel the head of TO and fill the node registered under it. */
	public const ROUTER              = '_router';

	/** Held in reserve: nothing registers a node under it. `Settings_Event_Writer` names its transient Partition `settings:writer` instead. */
	public const SETTINGS_LOG        = '_settings:log';

	/** `Connect_Queue_Timer_Node`'s single instance, mounted only while the connect queue holds work. */
	public const CONNECT_TIMER       = '_connect_timer';

	/** The `SSE_Out_Node` egress. A browser command carries `_sse:<pid>` in FROM so the stream process can gate the reply to its own session. */
	public const SSE                 = '_sse';

	/** The FROM stamp `Stdin_Node` puts on the lines and the EOF marker it emits; no node is registered under it. */
	public const STDIN               = '_stdin';

	/** The terminal writer the cli's `_output` Dumper targets. */
	public const STDOUT              = '_stdout';

	/** Browser-side node publishing the elapsed run the console header's LIVE button shows. */
	public const UPTIME              = '_uptime';

	/**
	 * The baseline names `dump_config` skips and `remove_node` refuses.
	 *
	 * A dump omits them because every session already has them, so emitting one
	 * would build it twice on replay. A remove refuses them because destroying
	 * one breaks the session issuing the command: without `_router` no
	 * addressed message is deliverable, and without `_command_interpreter` no
	 * further verb runs.
	 *
	 * @var array<int,string>
	 */
	public const SESSION_SCAFFOLDING = [
		self::COMMAND_INTERPRETER,
		self::CONNECT_TIMER,
		self::FLEET,
		self::ROUTER,
		self::OUTPUT,
		self::CONSOLE_TAP,
		self::STDIN,
		self::STDOUT,
	];
}

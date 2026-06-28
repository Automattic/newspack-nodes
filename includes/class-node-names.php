<?php
/**
 * Reserved node names — canonical map shared with the JS wiring.
 *
 * Mirror of `src/runtime/reserved-node-names.json`; the NodeNamesTest no-drift
 * guard fails if the two diverge. The reply pivot routes by these exact
 * strings, so a typo on either side silently misroutes.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/** @api Used to prevent naming drift */
final class Node_Names {
	public const COMMAND_INTERPRETER = '_command_interpreter';
	public const CONSOLE_TAP         = '_shell';
	public const COMPLETION          = '_completion';
	public const CWD                 = '_cwd';
	public const DMESG               = '_dmesg';
	public const HEARTBEAT           = '_heartbeat';
	public const HTTP                = '_http';
	public const METADATA            = '_metadata';
	public const OUTPUT              = '_output';
	public const REPL                = '_repl';
	public const ROUTER              = '_router';
	public const SETTINGS_LOG        = '_settings:log';
	public const SSE                 = '_sse';
	public const TOPICPROBE          = '_topicprobe';
	public const TOPICPROBE_LOG      = '_topicprobe:log';
	public const UPTIME              = '_uptime';
}

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

final class Node_Names {
	public const ROUTER              = '_router';
	public const COMMAND_INTERPRETER = '_command_interpreter';
	public const HTTP                = '_http';
	public const OUTPUT              = '_output';
	public const REPL                = '_repl';
	public const SSE                 = '_sse';
	public const METADATA            = '_metadata';
	public const UPTIME              = '_uptime';
	public const COMPLETION          = '_completion';
	public const HEARTBEAT           = '_heartbeat';
	public const CWD                 = '_cwd';
}

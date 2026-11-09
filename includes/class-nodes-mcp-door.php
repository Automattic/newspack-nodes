<?php
/**
 * Nodes_Mcp_Door: the substrate's own MCP door, the cockpit.
 *
 * A declaration on `Mcp_Door` (ADR-38), like every door. Its tools are the
 * commands the substrate's service CIs declare, derived over
 * `Bootstrap::SUBSTRATE_CIS`, so a command added to one of those classes is
 * a tool with no edit here; only the exclusions are kept by hand.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Declares the cockpit: its namespace, tools, glossary and caveat.
 */
class Nodes_Mcp_Door extends Mcp_Door {

	/**
	 * Mount name => the verbs left out of the tools, beside every command
	 * declaring a `secret` arg, which `declared_tools()` leaves out itself:
	 * `vault add` and `vault update`. `sessions create` mints a bearer key.
	 * `topologies connect_worker_input`
	 * and `mount_tables` mount nodes into this request's graph, which ends with
	 * the reply. `workers heartbeat` refreshes an SSE slot an MCP session never
	 * holds, and `raw-logs read_block` answers its block to the envelope's
	 * FROM, which a door's call does not carry.
	 *
	 * @var array<string,list<string>>
	 */
	public const NOT_TOOLS = [
		'sessions'   => [ 'create' ],
		'topologies' => [ 'connect_worker_input', 'mount_tables' ],
		'workers'    => [ 'heartbeat' ],
		'raw-logs'   => [ 'read_block' ],
	];

	/** The glossary `initialize` serves between the fence note and the caveat. */
	private const INSTRUCTIONS = 'These tools run the newspack-nodes substrate: its worker fleet, topologies, '
		. 'logs, settings and Vault. A topology is a named `.tsl` graph of nodes, active or inactive; an active '
		. 'topology runs as workers, one for each of its partitions, each named by a worker id `<type>.p<n>`. A '
		. 'worker slot\'s state is `live` (its heartbeat is current), `stale` (its heartbeat is overdue), `held` '
		. '(a deploy hold keeps it stopped), `idle` (an on-demand worker asleep until work arrives), `down` (not '
		. 'running) or `inactive` (its topology is not active). A dead letter is a message a worker could not '
		. 'deliver, quarantined beside the log it was reading. The Vault holds the spokes, the remote sites a hub '
		. 'connects out to; no tool reveals a stored password. `workers_inspect` runs one read-only interpreter '
		. 'command, such as `ls`, `dump_node` or `stats`, inside one live worker and returns its reply; every other '
		. 'tool answers from the site itself. Among the manage tools, `workers_restart` restarts workers, '
		. '`topologies_save`, `topologies_activate`, `topologies_deactivate` and `topologies_delete` change which '
		. 'graphs run, `sessions_revoke` ends a session and `vault_delete` removes a spoke.';

	/** The caveat `initialize` closes on and every tool description carries. */
	private const CAVEAT = 'The manage tools change the running fleet, so call them only on the operator\'s own request.';

	/** @api Read by the substrate's Mcp_Door. */
	protected function rest_namespace(): string {
		return 'newspack-nodes/v1';
	}

	/**
	 * One `<mount>_<verb>` tool per command each substrate CI declares, but
	 * those NOT_TOOLS names, the mount's hyphen written as an underscore.
	 *
	 * @api Read by the substrate's Mcp_Door.
	 */
	protected function tools(): array {
		$tools = [];
		foreach ( Bootstrap::SUBSTRATE_CIS as $mount => $class ) {
			$tools += self::declared_tools( $mount, $class, \str_replace( '-', '_', $mount ), self::NOT_TOOLS[ $mount ] ?? [] );
		}
		return $tools;
	}

	/** @api Read by the substrate's Mcp_Door. */
	protected function instructions(): string {
		return self::INSTRUCTIONS;
	}

	/** @api Read by the substrate's Mcp_Door. */
	protected function caveat(): string {
		return self::CAVEAT;
	}

	/** @api Read by the substrate's Mcp_Door; nothing in the text is read at listing. */
	protected function fills(): array {
		return [];
	}

	/** @api Read by the substrate's Mcp_Door. */
	protected function server_info(): array {
		return [
			'name'    => 'newspack-nodes',
			'version' => \NEWSPACK_NODES_VERSION,
		];
	}
}

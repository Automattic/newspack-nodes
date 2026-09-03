<?php
/**
 * Status_CI: the health and version probe for the substrate.
 *
 * Mounted as `status` on the request-scope interpreter by
 * `newspack_nodes_mount_substrate_cis()`.
 *
 * Verbs:
 *   get — one snapshot: the runtime version, the partition count the fleet
 *         runs, the active topology set, whether a shared cache is reachable,
 *         and the server's clock. A caller asking "is this install alive, and
 *         what is it running?" gets the whole answer in one round trip
 *         instead of one call per field.
 *
 * Every field is read through the accessor that OWNS it rather than the
 * option behind it. `Bootstrap::global_num_partitions()` clamps the count to
 * the range a worker consumes, so the probe never reports partitions nothing
 * reads; `Bootstrap::get_topologies()` narrows the catalog to the names an
 * operator activated, so it never reports a topology that spawns nothing; and
 * `Cache_Backend::shared_first()` answers with the tier a cross-process
 * surface would actually select.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Service_CI_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * The `status` service interpreter: one read-only `get` verb.
 */
class Status_CI_Node extends Service_CI_Node {

	/**
	 * `get` verb handler — the health and version snapshot, read in one pass.
	 *
	 * `status` is the constant `ok` because reaching this handler IS the health
	 * signal: a refusal leaves as a TM_COMMAND|TM_ERROR reply carrying the
	 * reason, never as a payload with a worse word in this field.
	 *
	 * `runtime_version` falls back to `unknown` rather than fataling on the
	 * undefined constant. The plugin entry point defines it, so the fallback
	 * only shows where the class was loaded without that entry point, and a
	 * probe that answers "I cannot tell you my version" beats one that dies.
	 *
	 * `cache_available` is false when neither memcached nor APCu is reachable.
	 * That is the condition every cross-process surface — SSE slot leases, live
	 * worker positions, `Table_Node` lookups — degrades under, so it is the
	 * first thing to read when those look stalled.
	 *
	 * `timestamp` is the server's wall clock at the read, which is what lets a
	 * caller age the snapshot and spot a skewed host.
	 *
	 * @return array<string,mixed> The snapshot: status, runtime_version, num_partitions, topologies, cache_available, timestamp.
	 */
	public static function cmd_get(): array {
		$cache_available = null !== Cache_Backend::shared_first();

		return [
			'status'          => 'ok',
			'runtime_version' => \defined( 'NEWSPACK_NODES_VERSION' ) ? \NEWSPACK_NODES_VERSION : 'unknown',
			// The ONE clamped accessor; raw reports a count nobody runs.
			'num_partitions'  => Bootstrap::global_num_partitions(),
			'topologies'      => \array_keys( Bootstrap::get_topologies() ),
			'cache_available' => $cache_available,
			'timestamp'       => \time(),
		];
	}

	/**
	 * Palette entry and verb declaration: `get` declared ONCE, carrying its
	 * handler and the role it demands.
	 *
	 * The inherited `Service_CI_Node` constructor builds the dispatch table
	 * from this array and wraps the handler in `Capabilities::require()` for
	 * the declared role, so this class needs no constructor and no hand-built
	 * verb table that could drift from what `help` and the console palette
	 * show. The role is READ, not MANAGE, because the snapshot reads state and
	 * changes none — a dashboard polls it.
	 *
	 * `category` replaces the `Hidden` inherited from the interpreter, which is
	 * what lists this class in the console palette beside the other service
	 * CIs; left Hidden, the catalog scan would drop it with nothing thrown.
	 *
	 * `arguments` is empty: `make_node` hands this node nothing, and `get`
	 * takes no arguments of its own.
	 *
	 * @api Used by substrate.
	 * @return array<string,mixed> This class's schema merged over the interpreter's.
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Health/version probe: runtime version, partition count, active topologies, cache reachability, timestamp.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'get',
					'capability'  => Capabilities::READ,
					'description' => 'Return a single-shot health snapshot for the admin "is this thing alive?" panel.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_get(),
				],
			],
		] );
	}
}

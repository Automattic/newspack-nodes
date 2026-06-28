<?php
/**
 * Aggregator_CI: command-dispatch for the hub-side aggregator dashboards.
 *
 * Canonical implementation of the three hub-side aggregator endpoints
 * that the legacy `newspack-nodes-aggregator/v1` namespace exposed:
 * `status`, `servers`, `health`. The dashboard cutover (commit 1350303)
 * migrated `AggregatorStatus.js` from `apiFetch('.../v1/status')` to
 * `commandClient.send('aggregator', 'status')`. The legacy
 * `AggregatorController` REST shim is preserved for any non-dashboard
 * caller and holds its `/status` body in parity with the `status` verb
 * here; the dedicated `AggregatorStatusController` (which the shim used
 * to delegate to) was deleted in the M4 cutover. Mounts at priority 11
 * alongside the rest of the M2 service CIs.
 *
 * Verbs:
 *   status  — per-node partition snapshot keyed by the wired Remote_Source
 *             NODE NAME. Discovers each Remote_Source wired into the active
 *             `aggregator` topology graph (`Topology_Registry::graph_for`,
 *             filtered on node `type === 'Remote_Source'`), then for every
 *             configured partition reads that node's substrate status snapshot
 *             from memcache under `np:remote:<node-name>:<remote_partition>` —
 *             the exact key Remote_Link writes. The `<vault-id>` and the
 *             `<remote_partition>` template come from the 2-arg make_node line;
 *             the `<partition>` token is substituted 0..num_partitions-1. The
 *             spoke URL is resolved from the Vault by the node's vault-id arg.
 *             Cache misses default to an empty array, not null.
 *   summary — de-god header slice: { connected, total, server_now } derived
 *             server-side from the SAME snapshot `status` builds. The dashboard
 *             header reads this tiny blob instead of recomputing the connected
 *             rollup from the full partition payload. `connected` counts servers
 *             with >=1 connected partition; `server_now` is the snapshot clock.
 *   servers_status — de-god server-cards slice: the snapshot `status` builds,
 *             re-indexed as a SEQUENTIAL ARRAY (the React card list maps over
 *             it). Both slice verbs return a JSON STRING (the substrate
 *             SliceViewNode contract) via Service_CI_Node::slice_verb().
 *   health  — cache reachability + wall-clock timestamp. Mirrors the
 *             legacy {healthy, cache, timestamp} shape. Cache probe is
 *             wrapped in a Throwable catch so the endpoint never fails
 *             — a cache outage reports `cache=false`, not 500.
 *   servers — sequential array of registered servers with public-safe
 *             shape (id, url, has_credentials, is_config),
 *             matching the substrate Vault_CI public shape, but RETURNED
 *             AS A SEQUENTIAL ARRAY rather than a map keyed by id. Legacy
 *             contract — the React aggregator tree relies on the array
 *             shape; don't switch to a keyed map here.
 *
 * Auth: all three verbs require `manage_options`. Legacy parity — both
 * controllers gated every route through `read_permissions_check()`,
 * which enforces the capability.
 *
 * Memcache reads go through the shared `Core::$memd` handle: the `status`
 * verb reads `np:remote:<node-name>:<remote_partition>` per partition; the
 * `health` verb reports whether the handle is configured. The `status`/`servers` verbs
 * read the substrate `Newspack_Nodes\Vault` singleton directly — there is
 * no injected registry dependency.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Vault;

\defined( 'ABSPATH' ) || exit;

class Aggregator_CI_Node extends Service_CI_Node {
	/**
	 * `status` verb handler — per-node partition snapshot for each wired Remote_Source.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_status(): array {
		self::require_manage_options();
		return self::build_snapshot();
	}

	/**
	 * Build the per-node partition snapshot, keyed by the wired Remote_Source
	 * NODE NAME. The single source of truth the `status`, `summary`, and
	 * `servers_status` verbs share — so the legacy `status` shim and the de-god
	 * dashboard slices can never disagree about what they saw.
	 *
	 * Discovers each Remote_Source wired into the active `aggregator` topology
	 * graph, then for every configured partition reads that node's substrate
	 * status snapshot from memcache under `np:remote:<node-name>:<remote_partition>`
	 * (the exact key Remote_Link writes). Cache misses default to an empty array.
	 *
	 * @return array<string, array{id:string,vault_id:string,url:string,partitions:array<int,array<array-key,mixed>>}>
	 */
	private static function build_snapshot(): array {
		$registry = Vault::get_instance();
		$registry->reset_cache();

		// remote_partition embeds the `<partition>` token → fan across the SPAWN-aligned count.
		$num_partitions = Bootstrap::num_partitions_for( 'aggregator' );

		$result = [];
		foreach ( Topology_Registry::graph_for( 'aggregator' )['nodes'] as $node ) {
			if ( 'Remote_Source' !== ( $node['type'] ?? '' ) ) {
				continue;
			}
			$name_v = $node['name'] ?? '';
			$name   = Core::as_string( $name_v );
			if ( '' === $name ) {
				continue;
			}
			// args: <vault-id> <remote_partition> (the Remote_Link 2-arg schema).
			$node_args = $node['args'] ?? [];
			$vault_id  = $node_args[0] ?? '';
			$template  = $node_args[1] ?? '';

			// Reconstruct the writer's exact key np:remote:<node-name>:<concrete remote_partition>.
			$partitions = [];
			for ( $p = 0; $p < $num_partitions; $p++ ) {
				$concrete         = Core::resolve_partition_template( $template, $p );
				$val              = Core::$memd?->get( "np:remote:{$name}:{$concrete}" );
				$partitions[ $p ] = \is_array( $val ) ? $val : [];
			}

			$entry = '' !== $vault_id ? $registry->get( $vault_id ) : null;
			$url_v = \is_array( $entry ) ? ( $entry['url'] ?? null ) : null;

			$result[ $name ] = [
				'id'         => $name,
				'vault_id'   => $vault_id,
				'url'        => \is_scalar( $url_v ) ? \esc_url_raw( (string) $url_v ) : '',
				'partitions' => $partitions,
			];
		}

		return $result;
	}

	/**
	 * `health` verb handler — cache reachability + wall-clock timestamp.
	 *
	 * @return array<string,mixed>
	 */
	public static function cmd_health(): array {
		self::require_manage_options();
		return [
			'healthy'   => true,
			'cache'     => null !== Core::$memd,
			'timestamp' => \time(),
		];
	}

	/**
	 * `servers` verb handler — registered servers as a sequential array (legacy contract).
	 *
	 * @return array<int, mixed>
	 */
	public static function cmd_servers(): array {
		self::require_manage_options();
		$registry = Vault::get_instance();
		$registry->reset_cache();
		$out = [];
		foreach ( $registry->get_all() as $id => $cfg ) {
			$url_v   = $cfg['url'] ?? '';
			$out[]   = [
				'id'              => $id,
				'url'             => Core::as_string( $url_v ),
				'has_credentials' => ! empty( $cfg['auth_username'] ) && ! empty( $cfg['auth_password'] ),
				'is_config'       => $registry->is_config_server( $id ),
			];
		}
		// Sequential array, NOT a map keyed by id — legacy contract the
		// React aggregator tree relies on.
		return $out;
	}

	/** @api Used by the substrate to provide UI etc. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Hub-side aggregator dashboards: per-server status, cache health, registered servers.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'status',
					'description' => 'Per-node partition snapshot for each wired Remote_Source in the active aggregator topology.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array => self::cmd_status(),
				],
				[
					'name'        => 'summary',
					'description' => 'De-god header slice: connected/total counts + snapshot clock (computed from the status snapshot).',
					'args'        => [],
					'handler'     => self::slice_verb( static function (): array {
						$snapshot  = self::build_snapshot();
						$connected = 0;
						foreach ( $snapshot as $server ) {
							foreach ( $server['partitions'] as $partition ) {
								if ( true === ( $partition['connected'] ?? false ) ) {
									++$connected;
									break;
								}
							}
						}
						return [
							'connected'  => $connected,
							'total'      => \count( $snapshot ),
							'server_now' => \time(),
						];
					} ),
				],
				[
					'name'        => 'servers_status',
					'description' => 'De-god server-cards slice: the status snapshot as a sequential array.',
					'args'        => [],
					'handler'     => self::slice_verb( static fn (): array => \array_values( self::build_snapshot() ) ),
				],
				[
					'name'        => 'health',
					'description' => 'Cache reachability + wall-clock timestamp.',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array => self::cmd_health(),
				],
				[
					'name'        => 'servers',
					'description' => 'Registered servers as a sequential array (legacy aggregator-tree contract).',
					'args'        => [],
					'handler'     => static fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): array => self::cmd_servers(),
				],
			],
		] );
	}

}

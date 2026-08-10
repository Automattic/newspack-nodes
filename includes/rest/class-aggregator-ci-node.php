<?php
/**
 * Aggregator_CI: command-dispatch for the hub-side aggregator dashboards.
 *
 * Command-dispatch for the hub-side aggregator verbs — `status`, `servers`,
 * `health`, plus the de-god slices `summary` / `servers_status`. The dashboard
 * reaches them via a command addressed `TO = _http/aggregator`. Mounts at
 * priority 11 alongside the rest of the M2 service CIs.
 *
 * Verbs:
 *   status  — per-node partition snapshot keyed by the wired Remote_Source
 *             NODE NAME. Discovers every Remote_Source wired into ANY active
 *             topology (`Topology_Registry::graph_for` per active name,
 *             filtered on node `type === 'Remote_Source'`), then for every
 *             configured partition reads that node's substrate status snapshot
 *             from memcache under `Remote_Source_Node::status_key_for()` —
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
 *   health  — cache reachability + wall-clock timestamp. Returns the stable
 *             {healthy, cache, timestamp} shape. Cache probe is
 *             wrapped in a Throwable catch so the endpoint never fails
 *             — a cache outage reports `cache=false`, not 500.
 *   servers — sequential array of registered servers with public-safe
 *             shape (id, url, has_credentials, is_config),
 *             matching the substrate Vault_CI public shape, but RETURNED
 *             AS A SEQUENTIAL ARRAY rather than a map keyed by id. The
 *             React aggregator tree relies on the array shape; don't switch
 *             to a keyed map here.
 *
 * Auth: every verb requires `manage_options`.
 *
 * Memcache reads go through the shared `Core::$memd` handle: the `status`
 * verb reads `Remote_Source_Node::status_key_for()` per partition; the
 * `health` verb reports whether the handle is configured. The `status`/`servers` verbs
 * read the substrate `Newspack_Nodes\Vault` singleton directly — there is
 * no injected registry dependency.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Vault;

\defined( 'ABSPATH' ) || exit;

class Aggregator_CI_Node extends Service_CI_Node {

	/**
	 * `probe` verb — on-demand deep probe of ONE spoke: POST its
	 * `workers/dump_graph` (via `HTTP_Out_Node::probe_command()` + its `$http_call`
	 * seam) and roll the reply into a compact whitelisted shape. The polled
	 * `summary`/`servers_status` slices carry connection health only; this
	 * verb is the button-triggered depth (worker liveness, worst consumer lag,
	 * dead-letter total). Never proxies raw remote JSON.
	 *
	 * @param list<string> $args Verb argument tokens (`<id>`).
	 * @return array<string,mixed> Compact per-spoke roll-up.
	 */
	public static function cmd_probe( array $args ): array {
		$id = Command_Args::parse( $args )['positional'][0] ?? '';
		if ( '' === $id ) {
			throw new \RuntimeException( 'id required' );
		}
		$server = Vault::fresh()->get( $id );
		if ( null === $server ) {
			throw new \RuntimeException( \esc_html( "server not found: {$id}" ) );
		}
		return self::fleet_rollup( $id, HTTP_Out_Node::probe_command( $id, $server, 'workers', 'dump_graph' ) );
	}

	/**
	 * Whitelist + roll up a spoke's `dump_graph` payload into named fields only:
	 * worker live/stale/dead counts, worst consumer distance, dead-letter total.
	 * A worker that is neither live nor stale is a never-started `dead`.
	 *
	 * @param string                 $id      Spoke id.
	 * @param array<array-key,mixed> $payload The spoke's dump_graph payload.
	 * @return array<string,mixed> Compact roll-up.
	 */
	private static function fleet_rollup( string $id, array $payload ): array {
		$workers = Core::arr( $payload['workers'] ?? [] );
		$live    = 0;
		$stale   = 0;
		$dead    = 0;
		foreach ( $workers as $worker ) {
			$worker = Core::arr( $worker );
			if ( true === ( $worker['live'] ?? false ) ) {
				++$live;
			} elseif ( true === ( $worker['stale'] ?? false ) ) {
				++$stale;
			} else {
				++$dead;
			}
		}

		$worst_distance = 0;
		foreach ( Core::arr( $payload['consumers'] ?? [] ) as $consumer ) {
			$distance = Core::num_int( Core::arr( $consumer )['distance'] ?? 0 );
			if ( $distance > $worst_distance ) {
				$worst_distance = $distance;
			}
		}

		return [
			'id'                  => $id,
			'workers'             => [
				'total' => \count( $workers ),
				'live'  => $live,
				'stale' => $stale,
				'dead'  => $dead,
			],
			'worst_distance'      => $worst_distance,
			'deadletter_segments' => Core::num_int( $payload['deadletter_segments'] ?? 0 ),
		];
	}
	/**
	 * Build the per-node partition snapshot, keyed by the wired Remote_Source
	 * NODE NAME. The single source of truth the `summary` and `servers_status`
	 * verbs share — so the de-god dashboard slices can never disagree about
	 * what they saw.
	 *
	 * Discovers every Remote_Source wired into ANY active topology
	 * graph, then for every configured partition reads that node's substrate
	 * status snapshot from memcache under `Remote_Source_Node::status_key_for()`
	 * (the exact key Remote_Link writes). Cache misses default to an empty array.
	 *
	 * @return array<string,array{id:string,vault_id:string,url:string,partitions:array<int,array<array-key,mixed>>}>
	 */
	private static function build_snapshot(): array {
		$registry = Vault::fresh();

		$result = [];
		// Readers live in ANY active topology, whatever its name.
		foreach ( \array_keys( Bootstrap::get_topologies() ) as $topology ) {
			$topology = Core::as_string( $topology );
			// remote_partition has a <partition> token; fan across the count.
			$num_partitions = Bootstrap::num_partitions_for( $topology );
			foreach ( Topology_Analyzer::graph_for( $topology )['nodes'] as $node ) {
				if ( 'Remote_Source' !== ( $node['type'] ?? '' ) ) {
					continue;
				}
				$name_v = $node['name'] ?? '';
				$name   = Core::as_string( $name_v );
				if ( '' === $name ) {
					continue;
				}
				// args: <vault-id> <remote_partition> (2-arg schema).
				$node_args = $node['args'] ?? [];
				$vault_id  = $node_args[0] ?? '';
				$template  = $node_args[1] ?? '';

				// The writer's own builder, so the two cannot drift.
				$partitions = [];
				for ( $p = 0; $p < $num_partitions; $p++ ) {
					$concrete         = Core::resolve_partition_template( $template, $p );
					$val              = \Newspack_Nodes\Cache_Backend::shared_first()?->get( \Newspack_Nodes\Remote_Source_Node::status_key_for( $name, $concrete ) );
					$partitions[ $p ] = Core::arr( $val );
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
		}

		return $result;
	}

	/**
	 * One server's three-state reading, best partition wins: `connected` while
	 * any partition streams, `idle` while one is closed at EOF and due back, and
	 * `down` otherwise. Idle is healthy — counting it as missing reads as a
	 * shortfall on a fleet where nothing is wrong.
	 *
	 * @param array<int,array<array-key,mixed>> $partitions Per-partition snapshots.
	 * @return string One of connected|idle|down.
	 */
	private static function server_state( array $partitions ): string {
		$state = 'down';
		foreach ( $partitions as $partition ) {
			if ( true === ( $partition['connected'] ?? false ) ) {
				return 'connected';
			}
			if ( null !== ( $partition['scheduled_reconnect_at'] ?? null ) ) {
				$state = 'idle';
			}
		}
		return $state;
	}

	/** @api Used by the substrate to provide UI etc. */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Hub-side aggregator dashboards: per-server status, cache health, registered servers.',
			'arguments'   => [],
			'commands'    => [
				[
					'name'        => 'summary',
					'description' => 'De-god header slice: connected/idle/total counts + snapshot clock (computed from the status snapshot).',
					'args'        => [],
					'handler'     => self::slice_verb( static function (): array {
						$snapshot  = self::build_snapshot();
						$connected = 0;
						$idle      = 0;
						foreach ( $snapshot as $server ) {
							$state = self::server_state( $server['partitions'] );
							if ( 'connected' === $state ) {
								++$connected;
							} elseif ( 'idle' === $state ) {
								++$idle;
							}
						}
						return [
							'connected'  => $connected,
							'idle'       => $idle,
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
					'name'        => 'probe',
					'description' => 'On-demand deep probe of one spoke: roll up worker live/stale/dead, worst consumer lag, and dead-letter total via its workers/dump_graph.',
					'args'        => [
						[ 'name' => 'id', 'type' => 'string', 'required' => true ],
					],
					'handler'     => static fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): array => self::cmd_probe( self::arg_strings( $args ) ),
				],
			],
		] );
	}

}

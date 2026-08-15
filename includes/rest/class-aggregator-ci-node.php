<?php
/**
 * Aggregator_CI: command-dispatch for the hub-side aggregator dashboards.
 *
 * The dashboard reaches these verbs via a command addressed
 * `TO = _http/aggregator`. Mounts on `newspack_nodes/request_graph_ready`
 * alongside the rest of the substrate service CIs.
 *
 * Verbs — the three `node_schema()` declares, and only those:
 *   summary        — polled header slice: `{connected, idle, total, server_now}`
 *                    counted from `build_snapshot()`. The header reads this tiny
 *                    blob rather than re-deriving the rollup from the full
 *                    partition payload. `server_now` is the snapshot clock.
 *   servers_status — polled server-cards slice: the SAME snapshot, re-indexed as
 *                    a SEQUENTIAL ARRAY (the React card list maps over it).
 *                    Both slices go out as a JSON STRING — the substrate
 *                    SliceViewNode contract — via `Service_CI_Node::slice_verb()`.
 *   probe          — button-triggered deep probe of ONE spoke: POST its
 *                    `workers/dump_graph` through `HTTP_Out_Node::probe_command()`
 *                    and roll the reply into a whitelisted shape (worker
 *                    live/stale/dead, worst consumer lag, dead-letter total).
 *                    Never proxies raw remote JSON. The only verb here with a
 *                    remote-call surface.
 *
 * `build_snapshot()` is the single source both slices read, so they can never
 * disagree about what they saw. It discovers every `Remote_Source` wired into
 * ANY active topology (`Topology_Analyzer::graph_for` per active name), and for
 * each configured partition reads that node's status snapshot from the cache
 * under `Remote_Source_Node::status_key_for()` — the exact key Remote_Link
 * writes. Cache reads go through `Cache_Backend::shared_first()`; a miss is an
 * empty array, not null. The spoke URL comes from the `Vault` singleton, keyed
 * by the node's vault-id argument.
 *
 * Auth is the `Capabilities` role each verb declares, resolved through the
 * filterable `newspack_nodes/capability_map` — not a hardcoded capability.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Args;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Topology_Analyzer;
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
					$key              = Remote_Source_Node::status_key_for( $name, Core::resolve_partition_template( $template, $p ) );
					$partitions[ $p ] = Core::arr( Cache_Backend::shared_first()?->get( $key ) );
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
					'capability'  => Capabilities::READ,
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
					'capability'  => Capabilities::READ,
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

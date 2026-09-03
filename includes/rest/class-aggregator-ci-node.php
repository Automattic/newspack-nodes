<?php
/**
 * Aggregator_CI: the hub-side command surface behind the Aggregator Status
 * dashboard.
 *
 * A hub wires one `Remote_Source` per spoke partition, each pulling that
 * spoke's log over SSE and publishing its connection state to the shared
 * cache. This interpreter is the read side. It mounts as `aggregator` on
 * `newspack_nodes/request_graph_ready` beside the rest of the substrate
 * service CIs, and answers the three verbs `node_schema()` declares:
 *
 *   summary        — the polled header slice, `{connected, idle, total,
 *                    server_now}` counted from `build_snapshot()`, so the
 *                    header renders the roll-up without re-deriving it from
 *                    the full partition payload.
 *   servers_status — the polled card slice: the same snapshot re-indexed as a
 *                    SEQUENTIAL ARRAY, which is what the React card list maps
 *                    over.
 *   probe          — the button-triggered deep probe of ONE spoke, and the
 *                    only verb here that reaches the network.
 *
 * Both slices answer a JSON STRING through `Service_CI_Node::slice_verb()`,
 * the shape a browser SliceViewNode parses, and both read the one
 * `build_snapshot()` builder — so the header's counts and the cards they
 * summarize are derived identically rather than by two roll-ups that drift.
 * The dashboard batches the pair into a single POST, so they also answer from
 * one request.
 *
 * Each verb declares its `Capabilities` role in `node_schema()`, and
 * `Service_CI_Node` wraps every handler with it, resolved through the
 * filterable `newspack_nodes/capability_map` rather than a hardcoded
 * capability.
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

/**
 * Hub-side dashboard verbs: two polled snapshot slices and one spoke probe.
 */
class Aggregator_CI_Node extends Service_CI_Node {

	/**
	 * `probe` verb: POST one spoke's `workers/dump_graph` through
	 * `HTTP_Out_Node::probe_command()` (and its `$http_call` seam) and answer
	 * with the roll-up `fleet_rollup()` whitelists. The polled slices carry
	 * connection health only, so this is where a dashboard button reaches for
	 * worker liveness, consumer lag and dead-letter depth — one blocking
	 * request per click, never on the poll path.
	 *
	 * `<id>` is the VAULT id, not the `Remote_Source` node name: the spoke's
	 * URL and credentials live in the Vault, and `build_snapshot()` carries a
	 * `vault_id` on every row so a card can hand it straight back.
	 *
	 * @param list<string> $args Verb argument tokens (`<id>`).
	 * @return array<string,mixed> Compact per-spoke roll-up.
	 * @throws \RuntimeException When `<id>` is missing, names no Vault entry, or the spoke call fails.
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
	 * Reduce a spoke's `dump_graph` reply to named fields only: the worker
	 * live/stale/dead counts, the largest consumer distance in bytes behind its
	 * source, and the dead-letter segment total. A worker that is neither live
	 * nor stale has never started, which counts as `dead`.
	 *
	 * The whitelist is the point. `dump_graph` answers the spoke's whole
	 * operator-grade envelope — every worker, log, node and edge — and
	 * forwarding it would put a remote server's payload into the hub's
	 * dashboard, plus whatever the spoke adds to that envelope next.
	 *
	 * @param string                 $id      The probed spoke's Vault id.
	 * @param array<array-key,mixed> $payload The spoke's dump_graph payload.
	 * @return array{id:string,workers:array{total:int,live:int,stale:int,dead:int},worst_distance:int,deadletter_segments:int} Compact roll-up.
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
	 * Build the per-node partition snapshot both slices read, keyed by the
	 * wired `Remote_Source` NODE NAME.
	 *
	 * Discovery covers every active topology, since an operator wires spokes
	 * into whatever topology suits and the substrate names none. Each
	 * `Remote_Source` found declares two schema arguments, the Vault id and the
	 * `remote_partition` template, and the row that comes out reads that node's
	 * status snapshot for every configured partition. The spoke URL comes from
	 * the `Vault` singleton, keyed by that Vault id.
	 *
	 * Reads go through `Cache_Backend::shared_first()`, and a miss yields an
	 * empty block rather than a missing entry, so the cards show a row per
	 * configured partition whether or not the reader has published yet.
	 *
	 * @return array<string,array{id:string,vault_id:string,url:string,partitions:array<int,array<array-key,mixed>>}>
	 */
	private static function build_snapshot(): array {
		$registry = Vault::fresh();

		$result = [];
		// An operator wires spokes into ANY active topology.
		foreach ( \array_keys( Bootstrap::get_topologies() ) as $topology ) {
			$topology = Core::as_string( $topology );
			// The remote_partition token fans across the partition count.
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
				$node_args = $node['args'] ?? [];
				$vault_id  = $node_args[0] ?? '';
				$template  = $node_args[1] ?? '';

				// The writer builds this key too; the two cannot drift.
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
	 * any partition streams, `idle` while any sits closed with a `retry:` delay
	 * and is due back, and `down` otherwise — a partition mid-handshake or in
	 * error backoff reads down.
	 *
	 * Idle earns its own state because it is healthy: the spoke closed that
	 * stream on purpose and says when it reopens, so counting it as missing
	 * reads as a shortfall on a fleet where nothing is wrong.
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

	/**
	 * Palette entry and verb table: the two polled slices and the probe, each
	 * with the role `Service_CI_Node` gates its handler on.
	 *
	 * @api Used by the substrate to provide UI etc.
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Service',
			'description' => 'Hub-side aggregator dashboard: per-spoke connection status and an on-demand fleet probe.',
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
					// No capability declared, so the gate demands MANAGE.
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

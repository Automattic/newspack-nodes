/**
 * useTopologyManager — the data hook for the Topology Manager dashboard tab. It
 * surfaces EVERY topology (active AND inactive) with provenance + active flag,
 * merges the live worker-status section onto the active ones, and exposes
 * `activate` / `deactivate` / `restart` mutations.
 *
 * DESIGN — option (B): build directly on the shared `useDashboardGraph` ONCE.
 * The two-hook composition of (A) — `useWorkerStatusGraph()` for status+restart
 * plus a second mount for the topologies poll — fights the shared single-mount
 * skeleton: each `useDashboardGraph` owns one `mountExospine` (one Core graph,
 * one poll/interval), and `Core` is a per-process singleton, so a second mount
 * would collide. Building on `useDashboardGraph` once gives one mount, one
 * interval, and lets the single `poll` fire BOTH `dump_graph` (→ worker-status
 * transform → view) and `topologies list` (→ topology view). We reuse the
 * worker-status transform + view node classes verbatim for the live status
 * model, so we don't fork their rate/segment math.
 *
 * Graph (clipped onto the rule-#2 backbone via the substrate's `_http`):
 *   _http                     (HttpOut — POST /command boundary; .client = CommandClient)
 *   workerstatus:transform    (dump_graph snapshot → enriched render model)
 *   workerstatus:view         (worker-status model React reads; restart pending-Map)
 *   topologymanager:view      (topologies list model React reads; activate/deactivate pending-Map)
 *
 * The poll fires `dump_graph` (FROM=transform) + `topologies list`
 * (FROM=topologymanager:view). `restart(name, partition)` dispatches the
 * `workers` `restart` verb (FROM=workerstatus:view); `activate`/`deactivate`
 * dispatch the `topologies` verbs (FROM=topologymanager:view), each settling a
 * Promise via the canonical pending-Map.
 *
 * The merge: index the worker-status model's per-topology sections by name
 * (its `graph` keys are topology names); for each `topologies.list` row attach
 * `status = byName[row.name] ?? null`.
 */

import { useCallback } from '@wordpress/element';
import { Core } from '../../runtime/core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	VALUE,
	TM_COMMAND,
} from '../../runtime/message';
import { useNodeState } from '../../runtime/react';
import { formatCommandArgs } from '../../runtime/command-args';
import {
	useDashboardGraph,
	makeOpId,
} from '@newspack-nodes/shared/hooks/useDashboardGraph';
import '../nodes/register';

// A partition is stalled when its heartbeat age exceeds interval × STALL_PAD;
// the pad tolerates a couple of missed beats without flicker.
export const STALL_PAD = 3;

const HTTP = '_http';
const TRANSFORM = 'workerstatus:transform';
const WORKER_VIEW = 'workerstatus:view';
const TOPOLOGY_VIEW = 'topologymanager:view';

/**
 * Build a TM_COMMAND addressed at a server CI: TO=`_http/<ci>` so the router
 * peels `_http` and HttpOut POSTs the bare command. `from` is the reply pivot.
 *
 * @param {string} ci   Server CI target (`workers` | `topologies`).
 * @param {string} verb Verb name.
 * @param {string} args Argument tail the verb parses (empty for nullary verbs).
 * @param {string} from Reply-pivot FROM (which node the reply lands at).
 * @param {string} id   Correlator stamped into message[ID].
 * @return {Array} A 7-field positional Message.
 */
function buildCommand( ci, verb, args, from, id ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = `${ HTTP }/${ ci }`;
	m[ ID ] = id;
	m[ VALUE ] = { name: verb, arguments: args };
	return m;
}

/**
 * Index the worker-status model's per-topology sections by name. The model's
 * `graph` keys ARE topology names; a topology's section is its graph entry plus
 * the workers whose `type` matches, carried alongside the SAME enriched
 * rate/segment/time slices WorkerStatus passes to TopologySection — so the
 * manager tree renders rates / ETA / segment bars / uptime with full richness,
 * not a degraded `{ graph, workers }` reduction (which both crashed TreeEntity's
 * un-defaulted `byteRates` read and would have shown a false 0 B/s under load).
 * A topology absent from the live graph has no section (→ null), which is what
 * the inactive rows get.
 *
 * @param {Object} model The worker-status view model (may be null pre-poll).
 * @return {Object} name → enriched section, for every topology in the graph.
 */
function sectionsByName( model ) {
	if ( ! model || ! model.graph ) {
		return {};
	}
	const workers = model.workers || [];
	const by = {};
	for ( const name of Object.keys( model.graph ) ) {
		by[ name ] = {
			graph: model.graph[ name ],
			workers: workers.filter(
				( w ) => ( w.type ?? w.handler ) === name
			),
			logs: model.logs ?? [],
			byteRates: model.byteRates ?? {},
			writeRates: model.writeRates ?? {},
			segmentSize: model.segmentSize,
			currentTime: model.currentTime,
			heartbeatIntervalS: model.heartbeatIntervalS ?? 10,
			prevSegments: model.prevSegments ?? {},
			removingSegments: model.removingSegments ?? {},
		};
	}
	return by;
}

/**
 * Derive a topology's per-partition stall flags and rolled-up health from its
 * live status section. A partition is stalled when its (process-level)
 * heartbeat_age exceeds `heartbeatIntervalS × STALL_PAD`; health rolls up to
 * `stalled` if any partition stalled, else `behind` if any consumer is behind,
 * else `ok`. An inactive topology (no section) gets no partitions and `ok`.
 *
 * @param {?Object} section A topology's enriched status section (or null).
 * @return {{ partitions: Array, health: string }} Partition stall flags + health.
 */
function deriveHealth( section ) {
	if ( ! section ) {
		return { partitions: [], health: 'ok' };
	}
	const workers = section.workers || [];
	const intervalS = section.heartbeatIntervalS ?? 10;
	const threshold = intervalS * STALL_PAD;
	const byPartition = new Map();
	let anyBehind = false;
	for ( const wk of workers ) {
		if ( wk.behind > 0 ) {
			anyBehind = true;
		}
		const age = wk.heartbeat_age;
		const stalled = age !== null && age !== undefined && age > threshold;
		const cur = byPartition.get( wk.partition );
		if ( ! cur ) {
			byPartition.set( wk.partition, {
				partition: wk.partition,
				stalled,
			} );
		} else if ( stalled ) {
			cur.stalled = true;
		}
	}
	const partitions = [ ...byPartition.values() ].sort(
		( a, b ) => a.partition - b.partition
	);
	const anyStalled = partitions.some( ( p ) => p.stalled );
	let health = 'ok';
	if ( anyStalled ) {
		health = 'stalled';
	} else if ( anyBehind ) {
		health = 'behind';
	}
	return { partitions, health };
}

/**
 * Dispatch an awaited verb through the live interpreter, settling on the named
 * view node's pending-Map. Rejects if the graph or view isn't mounted yet.
 *
 * @param {Object} interpreterRef The shared hook's live interpreter ref.
 * @param {string} viewName       The view node whose `replies` settles the Promise.
 * @param {string} ci             Server CI target.
 * @param {string} verb           Verb name.
 * @param {string} args           Argument tail.
 * @return {Promise} Settled by the matching reply.
 */
function dispatchAwaited( interpreterRef, viewName, ci, verb, args ) {
	const interpreter = interpreterRef.current;
	if ( ! interpreter ) {
		return Promise.reject( new Error( 'graph not mounted' ) );
	}
	const view = Core.node( viewName );
	if ( ! view ) {
		return Promise.reject( new Error( 'view not mounted' ) );
	}
	const id = makeOpId( 'topologymanager-op' );
	const promise = new Promise( ( resolve, reject ) => {
		view.replies.add( id, resolve, reject );
	} );
	interpreter.fill( buildCommand( ci, verb, args, viewName, id ) );
	return promise;
}

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`.
 * @param {number} [opts.refreshMs]     Poll interval in ms (default 4000).
 * @return {{ topologies: Array, supervisor: ?Object, currentTime: ?number,
 *   activate: Function, deactivate: Function, restart: Function,
 *   purgeOrphans: Function, connected: boolean }} The Topology Manager data +
 *   mutations: every topology row (status merged onto the active ones), the
 *   supervisor card, the clock for supervisor uptime, the mutation verbs (incl.
 *   the housekeeping-GC `purgeOrphans`), and connected.
 */
export function useTopologyManager( opts = {} ) {
	const { commandClient, refreshMs = 4000 } = opts;

	const { interpreterRef } = useDashboardGraph( {
		mountNodes: ( interpreter ) => {
			const transform = interpreter.makeNode(
				'WorkerStatusTransform',
				TRANSFORM
			);
			const workerView = interpreter.makeNode(
				'WorkerStatusView',
				WORKER_VIEW
			);
			interpreter.makeNode( 'TopologyManagerView', TOPOLOGY_VIEW );
			transform.target = WORKER_VIEW;
			return () => workerView.close();
		},
		poll: ( interpreter ) => {
			interpreter.fill(
				buildCommand(
					'workers',
					'dump_graph',
					'',
					TRANSFORM,
					makeOpId( 'topologymanager-op' )
				)
			);
			interpreter.fill(
				buildCommand(
					'topologies',
					'list',
					'',
					TOPOLOGY_VIEW,
					makeOpId( 'topologymanager-op' )
				)
			);
		},
		refreshMs,
		commandClient,
	} );

	const workerModel = useNodeState( WORKER_VIEW, 'view' );
	const topologyModel = useNodeState( TOPOLOGY_VIEW, 'view' );

	const rows = topologyModel?.topologies || [];
	const byName = sectionsByName( workerModel );
	const topologies = rows.map( ( row ) => {
		const status = byName[ row.name ] ?? null;
		const { partitions, health } = deriveHealth( status );
		return {
			name: row.name,
			source: row.source,
			active: row.active,
			num_partitions: row.num_partitions,
			status,
			partitions,
			health,
		};
	} );

	const supervisor = workerModel?.supervisor ?? null;
	const currentTime = workerModel?.currentTime;
	const connected = ! ( topologyModel?.error || workerModel?.error );

	// Request a graceful restart for a worker type (FROM=workerstatus:view so the
	// reply settles the worker view's pending-Map).
	const restart = useCallback(
		( name, partition = -1 ) =>
			dispatchAwaited(
				interpreterRef,
				WORKER_VIEW,
				'workers',
				'restart',
				partition >= 0
					? formatCommandArgs( [ name, String( partition ) ] )
					: formatCommandArgs( [ name ] )
			),
		[ interpreterRef ]
	);

	const activate = useCallback(
		( name ) =>
			dispatchAwaited(
				interpreterRef,
				TOPOLOGY_VIEW,
				'topologies',
				'activate',
				formatCommandArgs( [ name ] )
			),
		[ interpreterRef ]
	);

	const deactivate = useCallback(
		( name ) =>
			dispatchAwaited(
				interpreterRef,
				TOPOLOGY_VIEW,
				'topologies',
				'deactivate',
				formatCommandArgs( [ name ] )
			),
		[ interpreterRef ]
	);

	// Run the housekeeping GC (workers `purge_orphans`, no args), resolving with
	// its `{ removed, count }` payload (FROM=topologymanager:view).
	const purgeOrphans = useCallback(
		() =>
			dispatchAwaited(
				interpreterRef,
				TOPOLOGY_VIEW,
				'workers',
				'purge_orphans',
				''
			),
		[ interpreterRef ]
	);

	return {
		topologies,
		supervisor,
		currentTime,
		activate,
		deactivate,
		restart,
		purgeOrphans,
		connected,
	};
}

/**
 * useTopologyManager — the data hook for the Topology Manager / Overview fleet
 * board, rebuilt as a GENUINE node graph on the substrate's batched-poll toolkit
 * (helpers H3/H4). It surfaces EVERY topology (active AND inactive) with
 * provenance + active flag, merges the live worker-status section onto the active
 * ones, and exposes `activate` / `deactivate` / `restart` mutations.
 *
 * Graph (clipped onto the rule-#2 backbone the toolkit owns):
 *
 *   topologymanager:timer (Timer) ─> topologymanager:tee (Tee) ─> fetch-workers   ─┐ target = _shell/_http/workers
 *                                                              └> fetch-topologies ┤ target = _shell/_http/topologies
 *   workerstatus:in    (Tee) ─> workerstatus:transform ─> workerstatus:view ─> React
 *   topologymanager:in (Tee) ─> topologymanager:view                        ─> React
 *
 * `useBatchedPoll` owns ALL the poll boilerplate (the `_shell`-Tap + `_http`
 * HttpOut, the fan-out Tee + the router-hitchhike Timer, the lock/flush batch
 * bracket so a tick's two fetcher commands ride ONE POST, and the page-visibility
 * + `paused` gates). This hook supplies only its two slices via `addSliceFetcher`:
 *  - the worker slice fires `dump_graph` and rides the H4 `transform` slot, so the
 *    `WorkerStatusTransform` enrich-join lands on a graph EDGE (the workerstatus:in → view
 *    edge), not inside the view;
 *  - the topology slice fires `topologies list` straight into its view.
 *
 * SERVER APPROACH: `dump_graph` stays ONE verb (the four sections workers /
 * consumers / logs / graph must be joined from one coherent atomic snapshot — see
 * reconstructWorkers — so it can't be split into independently-timed slice verbs),
 * fanned to one transform→view on the client. `topologies list` is genuinely
 * independent → its own slice. Neither needs a server change; both are existing
 * verbs.
 *
 * Mutations are on-demand Fetchers (graph-visible through `_shell`), not
 * hook-callback → interpreter.fill: `dispatchAwaited` mounts a one-shot Fetcher
 * targeting `_shell/_http/<ci>` with FROM=<view>, fans a single trigger through it,
 * overlay's `connect _shell` sees the command flow.
 *
 * The merge: index the worker-status model's per-topology sections by name (its
 * `graph` keys are topology names); for each `topologies.list` row attach
 * `status = byName[row.name] ?? null`.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { Core } from '../../runtime/core';
import { useNodeState } from '../../runtime/react';
import { formatCommandArgs } from '../../runtime/command-args';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { globalRates } from '../globalRates';
import { etaSeconds } from '../formatters';
import '../nodes/register';

// Partition stalled when heartbeat age exceeds interval x STALL_PAD.
const STALL_PAD = 3;

// Stale once the last successful poll is older than this many poll intervals.
const STALE_POLL_INTERVALS = 3;

// A consumer is "behind" only once its catch-up ETA reaches this many seconds.
const BEHIND_ETA_S = 60;

const WORKER_VIEW = 'workerstatus:view';
const TOPOLOGY_VIEW = 'topologymanager:view';

// The server-side CIs the slices target through the substrate's `_shell/_http`.
const WORKERS_CI = 'workers';
const TOPOLOGIES_CI = 'topologies';

// Two slices: worker-status rides the transform slot; topology-list its view.
const SLICES = [
	{
		fetcher: 'fetch-workers',
		receiver: 'workerstatus:in',
		command: 'dump_graph',
		view: WORKER_VIEW,
		viewClass: 'WorkerStatusView',
		target: `_shell/_http/${ WORKERS_CI }`,
		transform: {
			name: 'workerstatus:transform',
			nodeClass: 'WorkerStatusTransform',
		},
	},
	{
		fetcher: 'fetch-topologies',
		receiver: 'topologymanager:in',
		command: 'list',
		view: TOPOLOGY_VIEW,
		viewClass: 'TopologyManagerView',
		target: `_shell/_http/${ TOPOLOGIES_CI }`,
	},
];

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
		return { partitions: [], health: 'ok', etaSeconds: 0 };
	}
	const workers = section.workers || [];
	const intervalS = section.heartbeatIntervalS ?? 10;
	const threshold = intervalS * STALL_PAD;
	const byPartition = new Map();
	let anyBehind = false;
	let worstEta = 0;
	for ( const wk of workers ) {
		// A consumer counts as "behind" only if its catch-up ETA is >= 1 min.
		const eta = etaSeconds( wk.behind, wk.read_rate );
		if ( eta >= BEHIND_ETA_S ) {
			anyBehind = true;
		}
		if ( eta > worstEta ) {
			worstEta = eta;
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
	return { partitions, health, etaSeconds: worstEta };
}

/**
 * Derive the connection banner state from BOTH the last poll's error flags AND
 * poll freshness. A wedged or silently-stalled channel returns no error but stops
 * advancing the freshness clock, so the error-flag-only check would keep
 * `connected` true forever; the freshness check catches that. Freshness is only
 * judged while the page is VISIBLE — a hidden tab pauses polling on purpose, so a
 * stale clock there is expected, not a disconnect. A never-stamped clock (0) is
 * treated as not-yet-stale so the banner doesn't flash before the first poll.
 *
 * @param {Object}  o               Inputs.
 * @param {boolean} o.topologyError The topologies model's last error flag.
 * @param {boolean} o.workerError   The worker-status model's last error flag.
 * @param {number}  o.lastPollMs    Wall-clock ms of the last poll fire (0 = never).
 * @param {number}  o.now           Current wall-clock ms.
 * @param {number}  o.refreshMs     Poll interval in ms.
 * @param {boolean} o.pageVisible   Whether the page is currently visible.
 * @return {boolean} Whether the dashboard is considered connected.
 */
function deriveConnected( {
	topologyError,
	workerError,
	lastPollMs,
	now,
	refreshMs,
	pageVisible,
} ) {
	if ( topologyError || workerError ) {
		return false;
	}
	if ( ! pageVisible || ! lastPollMs ) {
		return true;
	}
	return now - lastPollMs <= STALE_POLL_INTERVALS * refreshMs;
}

/**
 * @param {Object}  [opts]               Options (testing seams).
 * @param {Object}  [opts.commandClient] transport seam assigned to `_http.client`.
 * @param {boolean} [opts.paused]        Suspend polling (e.g. an Overview drag in flight).
 * @return {{ topologies: Array, supervisor: ?Object, currentTime: ?number,
 *   readRate: number, writeRate: number, logPartitions: number,
 *   activate: Function, deactivate: Function, restart: Function,
 *   connected: boolean }} The Topology Manager data + mutations: every topology
 *   row (status merged onto the active ones), the supervisor card, the clock for
 *   supervisor uptime, the fleet-global R/W byte rates + on-disk log-partition
 *   count for the summary cards, the mutation verbs, and connected.
 */
/**
 * Put the just-minted command on the wire NOW: a mutation is event-driven, not
 * part of the batched poll tick that would otherwise carry it.
 *
 * @param {Promise} pending The request's promise, returned unchanged.
 * @return {Promise} `pending`.
 */
function flushed( pending ) {
	Core.node( '_http' )?.flush();
	return pending;
}

export function useTopologyManager( opts = {} ) {
	const { commandClient, paused = false } = opts;
	const refreshMs = opts.refreshMs ?? 4000;

	useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, { ...slice, tee } )
			);
			const workerView = Core.node( WORKER_VIEW );
			return () => workerView?.close();
		},
		timerName: 'topologymanager:timer',
		teeName: 'topologymanager:tee',
		commandClient,
		paused,
	} );

	// One node per mutation verb; the reply that lands on it IS its answer.
	const restartNode = useRequestNode( 'workers:restart', WORKERS_CI );
	const activateNode = useRequestNode( 'topologies:activate', TOPOLOGIES_CI );
	const deactivateNode = useRequestNode(
		'topologies:deactivate',
		TOPOLOGIES_CI
	);

	const workerModel = useNodeState( WORKER_VIEW, 'view' );
	const topologyModel = useNodeState( TOPOLOGY_VIEW, 'view' );

	// Memoized so the topologies array keeps STABLE identity across renders.
	const topologies = useMemo( () => {
		const rows = topologyModel?.topologies || [];
		const byName = sectionsByName( workerModel );
		return rows.map( ( row ) => {
			const status = byName[ row.name ] ?? null;
			const {
				partitions,
				health,
				etaSeconds: eta,
			} = deriveHealth( status );
			return {
				name: row.name,
				source: row.source,
				active: row.active,
				num_partitions: row.num_partitions,
				status,
				partitions,
				health,
				etaSeconds: eta,
			};
		} );
	}, [ topologyModel, workerModel ] );

	const supervisor = workerModel?.supervisor ?? null;
	const currentTime = workerModel?.currentTime;

	// Last SUCCESSFUL poll: a fresh model identity is the success signal.
	const lastSuccessRef = useRef( 0 );
	useEffect( () => {
		if ( workerModel || topologyModel ) {
			lastSuccessRef.current = Date.now();
		}
	}, [ workerModel, topologyModel ] );

	// Re-evaluate connected on a heartbeat even with no reply (visible only).
	const pageVisible = usePageVisibility();
	const [ , bumpFreshness ] = useState( 0 );
	const bump = useCallback( () => bumpFreshness( ( n ) => n + 1 ), [] );
	useRouterTick( {
		name: 'topology-manager:freshness',
		onTick: bump,
		intervalMs: parseInt( refreshMs, 10 ),
	} );

	const connected = deriveConnected( {
		topologyError: Boolean( topologyModel?.error ),
		workerError: Boolean( workerModel?.error ),
		lastPollMs: lastSuccessRef.current,
		now: Date.now(),
		refreshMs: parseInt( refreshMs, 10 ),
		pageVisible,
	} );
	// Fleet-global byte rates + on-disk log-partition count for SummaryCards.
	const { readRate, writeRate } = globalRates(
		workerModel?.byteRates,
		workerModel?.writeRates
	);
	const logPartitions = workerModel?.logPartitions ?? 0;

	// Request a graceful restart; the reply lands on the node that asked.
	const restart = useCallback(
		( name, partition = -1 ) =>
			flushed(
				restartNode(
					'restart',
					partition >= 0
						? formatCommandArgs( [ name, String( partition ) ] )
						: formatCommandArgs( [ name ] )
				)
			),
		[ restartNode ]
	);

	const activate = useCallback(
		( name ) =>
			flushed(
				activateNode( 'activate', formatCommandArgs( [ name ] ) )
			),
		[ activateNode ]
	);

	const deactivate = useCallback(
		( name ) =>
			flushed(
				deactivateNode( 'deactivate', formatCommandArgs( [ name ] ) )
			),
		[ deactivateNode ]
	);

	return {
		topologies,
		supervisor,
		currentTime,
		readRate,
		writeRate,
		logPartitions,
		activate,
		deactivate,
		restart,
		connected,
	};
}

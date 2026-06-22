/**
 * useTopologyManager — the data hook for the Topology Manager dashboard tab. It
 * surfaces EVERY topology (active AND inactive) with provenance + active flag,
 * merges the live worker-status section onto the active ones, and exposes
 * `activate` / `deactivate` / `restart` mutations.
 *
 * DESIGN — option (B): build directly on the shared `useDashboardGraph` ONCE.
 * The two-hook composition of (A) — a dedicated worker-status hook for
 * status+restart plus a second mount for the topologies poll — fights the shared single-mount
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

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
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
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { globalRates } from '../globalRates';
import { etaSeconds } from '../formatters';
import '../nodes/register';

// A partition is stalled when its heartbeat age exceeds interval × STALL_PAD;
// the pad tolerates a couple of missed beats without flicker.
export const STALL_PAD = 3;

// The connection is "stale" once the last successful poll is older than this many
// poll intervals — a wedged/paused channel that returns no error still stops the
// freshness clock, which is what flips `connected` false.
export const STALE_POLL_INTERVALS = 3;

// A consumer is "behind" only once its catch-up ETA reaches this many seconds —
// a sub-minute backlog drains on its own and isn't worth flagging.
const BEHIND_ETA_S = 60;

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
export function deriveHealth( section ) {
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
		// A consumer counts as "behind" only if its ETA to catch up is >= 1 min;
		// a sub-minute backlog drains on its own and isn't worth flagging.
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
export function deriveConnected( {
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
 *   readRate: number, writeRate: number, logPartitions: number,
 *   activate: Function, deactivate: Function, restart: Function,
 *   connected: boolean }} The Topology Manager data + mutations: every topology
 *   row (status merged onto the active ones), the supervisor card, the clock for
 *   supervisor uptime, the fleet-global R/W byte rates + on-disk log-partition
 *   count for the summary cards, the mutation verbs, and connected.
 */
export function useTopologyManager( opts = {} ) {
	const { commandClient, refreshMs = 4000, paused = false } = opts;

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
		paused,
	} );

	const workerModel = useNodeState( WORKER_VIEW, 'view' );
	const topologyModel = useNodeState( TOPOLOGY_VIEW, 'view' );

	// Memoized on the two view models so the topologies array (and every topology
	// object) keeps a STABLE identity between renders that don't change the data —
	// e.g. an Overview drag-reorder, which re-renders every frame. Without this, a
	// fresh array each render breaks `memo` on every consumer (SummaryCards, each
	// TopologyRow), forcing a full re-render storm mid-drag.
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

	// Last SUCCESSFUL poll: a reply landing replaces the view model reference, so
	// a fresh model identity is our success signal. A wedged/silently-stalled
	// channel returns no error and produces no new model, so this clock stops —
	// which is exactly what flips `connected` false (the last-error-flag-only
	// check would stay true forever). Stamped from a ref so an unchanged model
	// (re-render with no new reply) keeps the prior success time.
	const lastSuccessRef = useRef( 0 );
	useEffect( () => {
		if ( workerModel || topologyModel ) {
			lastSuccessRef.current = Date.now();
		}
	}, [ workerModel, topologyModel ] );

	// Re-evaluate `connected` on a heartbeat even when no reply arrives — a
	// stalled channel produces no model update, so nothing else would re-render
	// us. Only while visible: a hidden tab pauses polling on purpose, so its stale
	// clock is expected. `bumpFreshness` exists solely to force that re-render.
	const pageVisible = usePageVisibility();
	const [ , bumpFreshness ] = useState( 0 );
	useEffect( () => {
		if ( ! pageVisible ) {
			return undefined;
		}
		const intervalMs = parseInt( refreshMs, 10 );
		const id = setInterval(
			() => bumpFreshness( ( n ) => n + 1 ),
			intervalMs
		);
		return () => clearInterval( id );
	}, [ refreshMs, pageVisible ] );

	const connected = deriveConnected( {
		topologyError: Boolean( topologyModel?.error ),
		workerError: Boolean( workerModel?.error ),
		lastPollMs: lastSuccessRef.current,
		now: Date.now(),
		refreshMs: parseInt( refreshMs, 10 ),
		pageVisible,
	} );
	// Fleet-global byte rates (Σ the live per-reader / per-log rate maps) and the
	// on-disk log-partition count — the SummaryCards' R / W / partitions numbers.
	const { readRate, writeRate } = globalRates(
		workerModel?.byteRates,
		workerModel?.writeRates
	);
	const logPartitions = workerModel?.logPartitions ?? 0;

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

/**
 * useTopologyManager — the data behind the Overview fleet board. It surfaces
 * EVERY topology the server knows, active and inactive alike, each carrying its
 * provenance and its active flag; it merges the live worker-status section onto
 * the active ones; and it exposes the `activate`, `deactivate` and `restart`
 * mutations.
 *
 * Graph, clipped onto the rule-#2 backbone `useBatchedPoll` owns:
 *
 *   topologymanager:timer (Timer) ─> topologymanager:tee (Tee) ─> fetch-workers   ─┐ target = _shell/_http/workers
 *                                                              └> fetch-topologies ┤ target = _shell/_http/topologies
 *   workerstatus:in    (Tee) ─> workerstatus:transform ─> workerstatus:view ─> React
 *   topologymanager:in (Tee) ─> topologymanager:view                        ─> React
 *
 * `useBatchedPoll` owns every piece of the poll boilerplate: the `_shell` Tap
 * and the `_http` HttpOut egress, the fan-out Tee and the router-hitchhike
 * Timer, the lock/flush bracket that puts a tick's two fetcher commands in ONE
 * POST, and the page-visibility and `paused` gates. This hook adds only its two
 * slices, through `addSliceFetcher`:
 *  - the worker slice fires `dump_graph` and fills the `transform` slot, so
 *    the `WorkerStatusTransform` enrich-join lands on the graph EDGE between
 *    `workerstatus:in` and the view rather than inside the view;
 *  - the topology slice fires `topologies list` straight into its view.
 *
 * `dump_graph` stays ONE verb rather than splitting into per-section slices.
 * `reconstructWorkers` joins its four sections — workers, consumers, logs and
 * graph — and that join is sound only over a single atomic snapshot, which
 * independently-timed slices cannot give it. `topologies list` shares nothing
 * with that snapshot, so it earns a slice of its own. Both verbs already exist;
 * neither needs a server change.
 *
 * The three mutations are `useCommandOnce` sends rather than a hook callback
 * calling `interpreter.fill`. Each parks its arguments in its own Fetcher's
 * outbox and pokes the Router, so the command leaves inside the same lock/flush
 * bracket as the poll and the debug overlay's `connect _shell` sees it flow. A
 * refusal returns a tick later as the verb's error text, addressed to the node
 * that asked (TO=FROM, ADR-7); `onError` reports it, and there is no promise to
 * reject.
 *
 * The merge indexes the worker-status model's per-topology sections by name —
 * its `graph` keys ARE topology names — and hands every `topologies list` row
 * `status = byName[ row.name ] ?? null`.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { useNodeState } from '../../runtime/react';
import { formatCommandArgs } from '../../runtime/command-args';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { globalRates } from '../globalRates';
import { etaSeconds } from '@newspack-nodes/shared/utils/formatters';
import { partitionSummaries } from '../partitionSummaries';
import { views } from '../nodes/register';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

/** Stale once the last successful poll is older than this many poll intervals. */
const STALE_POLL_INTERVALS = 3;

/** A consumer counts as "behind" once its catch-up ETA reaches this many seconds. */
const BEHIND_ETA_S = 60;

/** The view node publishing the enriched worker-status model. */
const WORKER_VIEW = 'workerstatus:view';

/** The view node publishing the topology list. */
const TOPOLOGY_VIEW = 'topologymanager:view';

/** The server CI owning `dump_graph` and `restart`. */
const WORKERS_CI = 'workers';

/** The server CI owning `list`, `activate` and `deactivate`. */
const TOPOLOGIES_CI = 'topologies';

/**
 * The two poll slices, in the shape `addSliceFetcher` wires. The worker slice
 * takes the `transform` slot so its enrich-join sits on a graph edge; the
 * topology list needs no join and goes straight to its view.
 */
const SLICES = [
	{
		fetcher: 'fetch-workers',
		receiver: 'workerstatus:in',
		command: 'dump_graph',
		view: WORKER_VIEW,
		viewClass: views.WorkerStatusView,
		target: egressPath( WORKERS_CI ),
		transform: {
			name: 'workerstatus:transform',
			nodeClass: views.WorkerStatusTransform,
		},
	},
	{
		fetcher: 'fetch-topologies',
		receiver: 'topologymanager:in',
		command: 'list',
		view: TOPOLOGY_VIEW,
		viewClass: views.TopologyManagerView,
		target: egressPath( TOPOLOGIES_CI ),
	},
];

/**
 * Index the worker-status model's per-topology sections by name, which its
 * `graph` keys already are. A section carries that graph entry, the workers
 * whose `type` matches, and the model's rate, segment and time slices whole.
 * `TopologyRow` reads `logs` to build the subtree and passes `writeRates`,
 * `segmentSize`, `currentTime`, `prevSegments` and `removingSegments` on to
 * `TopologySection`, so a reduced `{ graph, workers }` section would arrive
 * there with all five undefined.
 *
 * A topology absent from the live graph gets no section, which is what an
 * inactive row wants.
 *
 * @param {?Object} model The worker-status view model; null before the first poll.
 * @return {Object} Every topology in the live graph, keyed by name, mapped to
 *   its enriched section.
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
			prevSegments: model.prevSegments ?? {},
			removingSegments: model.removingSegments ?? {},
		};
	}
	return by;
}

/**
 * Derive a topology's per-partition stall flags and its rolled-up health from
 * the live status section. A partition is stalled when the server marked its
 * worker `stale`; health rolls up to `stalled` if any partition stalled, else
 * `behind` if any consumer is behind, else `ok`. An inactive topology has no
 * section, so it gets no partitions and `ok`.
 *
 * The stall verdict is the server's flag, never re-derived here: the server
 * judges each heartbeat against the topology's OWN declared `stale_timeout`,
 * which the job pools raise to 600s, so a local `heartbeatIntervalS × 3` would
 * call a live job worker stalled at 31s and contradict `wp nodes status`
 * reading that same heartbeat.
 *
 * The per-partition fold is `partitionSummaries()`, the same one `TopologyRow`
 * and `fleetSummary` use.
 *
 * @param {?Object} section A topology's enriched status section, or null.
 * @return {{ partitions: Array, health: string, etaSeconds: number }} The
 *   partition stall flags, the rolled-up health, and the worst catch-up ETA
 *   across the topology's consumers in seconds (0 caught up, Infinity
 *   stalled).
 */
function deriveHealth( section ) {
	if ( ! section ) {
		return { partitions: [], health: 'ok', etaSeconds: 0 };
	}
	const workers = section.workers || [];
	let anyBehind = false;
	let worstEta = 0;
	for ( const wk of workers ) {
		const eta = etaSeconds( wk.behind, wk.read_rate );
		if ( eta >= BEHIND_ETA_S ) {
			anyBehind = true;
		}
		if ( eta > worstEta ) {
			worstEta = eta;
		}
	}
	const partitions = partitionSummaries( workers ).map( ( p ) => ( {
		...p,
		stalled: p.stale,
	} ) );
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
 * A mutation the server refused, as `onError` receives it.
 *
 * @typedef {Object} TopologyRefusal
 * @property {string} name    The topology the refused verb named.
 * @property {string} message The verb's error text.
 */

/**
 * Mount the Topology Manager graph and expose its model and its mutations. See
 * the file header for the graph and the merge it performs.
 *
 * @param {Object}                       [opts]           Options.
 * @param {(r: TopologyRefusal) => void} [opts.onError]   Called with each refused
 *                                                        mutation. The refusal
 *                                                        arrives here rather than
 *                                                        as a rejected promise:
 *                                                        the answer to an activate
 *                                                        lands on the node that
 *                                                        asked, a tick later,
 *                                                        naming the topology it
 *                                                        was about.
 * @param {boolean}                      [opts.paused]    Suspend polling, as the
 *                                                        Overview does while a row
 *                                                        drag is in flight.
 * @param {number}                       [opts.refreshMs] Poll interval in ms, and
 *                                                        the unit of the staleness
 *                                                        window. Defaults to 5000.
 * @return {{ topologies: Array, readRate: number, writeRate: number,
 *   logPartitions: number, activate: (name: string) => void,
 *   deactivate: (name: string) => void,
 *   restart: (name: string, partition?: number) => void, connected: boolean }}
 *   Every topology row, with the live status merged onto the active ones; the
 *   fleet-global read and write byte rates and the on-disk log-partition count
 *   the summary cards draw; the three mutation verbs; and whether the board is
 *   connected.
 */
export function useTopologyManager( opts = {} ) {
	const { paused = false } = opts;

	// Read live, so a caller's inline handler is never a stale closure.
	const onErrorRef = useRef( opts.onError );
	onErrorRef.current = opts.onError;
	// Parsed once here; parseInt stringifies its argument anyway.
	const refreshMs = parseInt( String( opts.refreshMs ?? 5000 ), 10 );

	useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, { ...slice, tee } )
			);
		},
		timerName: 'topologymanager:timer',
		teeName: 'topologymanager:tee',
		paused,
		// One cadence for the poll and the freshness re-check below.
		intervalMs: refreshMs,
	} );

	/**
	 * Report a refused mutation. The interpreter echoes the command's arguments
	 * into its reply, so `args[ 0 ]` is the topology the refusal answers.
	 *
	 * @param {{error: ?string, args: string[]}} reply One verb's answer.
	 */
	const onMutationDone = useCallback( ( { error, args } ) => {
		if ( error ) {
			onErrorRef.current?.( { name: args[ 0 ], message: error } );
		}
	}, [] );
	const restartOnce = useCommandOnce( {
		ci: WORKERS_CI,
		command: 'restart',
		onDone: onMutationDone,
	} );
	const activateOnce = useCommandOnce( {
		ci: TOPOLOGIES_CI,
		command: 'activate',
		onDone: onMutationDone,
	} );
	const deactivateOnce = useCommandOnce( {
		ci: TOPOLOGIES_CI,
		command: 'deactivate',
		onDone: onMutationDone,
	} );

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
		name: 'topologymanager:freshness',
		onTick: bump,
		intervalMs: refreshMs,
	} );

	const connected = deriveConnected( {
		topologyError: Boolean( topologyModel?.error ),
		workerError: Boolean( workerModel?.error ),
		lastPollMs: lastSuccessRef.current,
		now: Date.now(),
		refreshMs,
		pageVisible,
	} );
	// Fleet-global byte rates + on-disk log-partition count for SummaryCards.
	const { readRate, writeRate } = globalRates(
		workerModel?.byteRates,
		workerModel?.writeRates
	);
	const logPartitions = workerModel?.logPartitions ?? 0;

	const { run: runRestart } = restartOnce;
	const { run: runActivate } = activateOnce;
	const { run: runDeactivate } = deactivateOnce;

	// Partition is an OPTION; positionally it reads as a second type filter.
	const restart = useCallback(
		( name, partition = -1 ) =>
			runRestart(
				formatCommandArgs(
					[ name ],
					partition >= 0 ? { partition } : {}
				)
			),
		[ runRestart ]
	);

	const activate = useCallback(
		( name ) => runActivate( formatCommandArgs( [ name ] ) ),
		[ runActivate ]
	);

	const deactivate = useCallback(
		( name ) => runDeactivate( formatCommandArgs( [ name ] ) ),
		[ runDeactivate ]
	);

	return {
		topologies,
		readRate,
		writeRate,
		logPartitions,
		activate,
		deactivate,
		restart,
		connected,
	};
}

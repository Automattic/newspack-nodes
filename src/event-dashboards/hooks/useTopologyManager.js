/**
 * useTopologyManager — the fleet board: EVERY topology the server knows,
 * active and inactive alike, each with its provenance and its active flag,
 * the live worker-status section merged onto the active ones, and the
 * `activate`, `deactivate` and `restart` mutations.
 *
 * The board reads two sources the Overview declares (`views.js`), each a
 * poll on the shared tick under the `topologies` group, so every block on
 * the page that reads one shares its fetch and its POST:
 *
 *   nodes/worker-status — `dump_graph`, through the `WorkerStatusTransform`
 *                         on the edge before its view, which joins the
 *                         snapshot's four sections into `workers[]`;
 *   nodes/topologies    — `topologies dump`, straight into its view.
 *
 * `dump_graph` stays ONE command: the join is sound only over a single atomic
 * snapshot. `topologyRows()` merges the two models, indexing the worker
 * model's per-topology sections by name, which its `graph` keys are, and
 * `nodes/board` derives the board through `boardOf()` once per answer.
 *
 * The three mutations are `useCommandOnce` sends riding the same tick. A
 * refusal returns as the command's error text, addressed to the node that
 * asked (TO=FROM, ADR-7), and `onError` reports it; every answer refreshes
 * both sources, so a toggle shows once the server has done it rather than on
 * the next poll. `useTopologyBoard()` is the board alone, for a reader that
 * sends nothing, and `useConnected()` its freshness.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { formatCommandArgs } from '../../runtime/command-args';
import useRouterTick from '@newspack-nodes/shared/hooks/useRouterTick';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import usePageVisibility from '@newspack-nodes/shared/hooks/usePageVisibility';
import { useSource } from '@newspack-nodes/shared/sources';
import { globalRates } from '../globalRates';
import { etaSeconds } from '@newspack-nodes/shared/utils/formatters';
import { partitionSummaries } from '../partitionSummaries';

/** Stale once the last successful poll is older than this many poll intervals. */
const STALE_POLL_INTERVALS = 3;

/** A consumer counts as "behind" once its catch-up ETA reaches this many seconds. */
const BEHIND_ETA_S = 60;

/** The server CI owning `dump_graph` and `restart`. */
const WORKERS_CI = 'workers';

/** The server CI owning `dump`, `activate` and `deactivate`. */
const TOPOLOGIES_CI = 'topologies';

/** The group every command the fleet board sends belongs to. */
export const BOARD_GROUP = 'topologies';

/** How often the board asks, and the unit of its staleness window. */
export const BOARD_MS = 5000;

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
		stalled: 'stale' === p.state,
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
 * @property {string} name    The topology the refused command named.
 * @property {string} message The command's error text.
 */

/**
 * Every topology row, the live status merged onto each active one with its
 * partitions, rolled-up health and worst catch-up ETA.
 *
 * @param {?Object} workerModel   The worker-status model.
 * @param {?Object} topologyModel The topology list model.
 * @return {Array<Object>} The rows.
 */
function topologyRows( workerModel, topologyModel ) {
	const byName = sectionsByName( workerModel );
	return ( topologyModel?.topologies || [] ).map( ( row ) => {
		const status = byName[ row.name ] ?? null;
		const { partitions, health, etaSeconds: eta } = deriveHealth( status );
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
}

/**
 * The fleet board one pair of answers makes: every row, the fleet-global
 * read and write rates, the on-disk partition count, the lines the probe read
 * skipped, each active topology that will not read and each log producer the
 * catalog left out, and both models. `nodes/board` derives it once per
 * answer, so every reader shares one join.
 *
 * @param {?Object} workerModel   The worker-status model.
 * @param {?Object} topologyModel The topology list model.
 * @return {{ topologies: Array, readRate: number, writeRate: number,
 *   logPartitions: number, unparseableLines: (number|undefined),
 *   unreadable: (Object<string,string>|undefined),
 *   refusedProducers: (Object<string,string>|undefined),
 *   workerModel: ?Object, topologyModel: ?Object }} The board.
 */
export function boardOf( workerModel, topologyModel ) {
	const { readRate, writeRate } = globalRates(
		workerModel?.byteRates,
		workerModel?.writeRates
	);
	return {
		topologies: topologyRows( workerModel, topologyModel ),
		readRate,
		writeRate,
		logPartitions: workerModel?.logPartitions ?? 0,
		unparseableLines: workerModel?.unparseableLines,
		unreadable: workerModel?.unreadable,
		refusedProducers: workerModel?.refusedProducers,
		workerModel,
		topologyModel,
	};
}

/** The board before its two polls answer. */
const NO_BOARD = boardOf( null, null );

/**
 * The fleet board as `nodes/board` shows it now, and a refresh of both its
 * polls.
 *
 * @return {ReturnType<typeof boardOf> & {refresh: () => void}} The board.
 */
export function useTopologyBoard() {
	const { model, refresh } = useSource( 'nodes/board' );
	return useMemo(
		() => ( { ...( model ?? NO_BOARD ), refresh } ),
		[ model, refresh ]
	);
}

/**
 * Whether the board is connected, re-judged on the poll's cadence whether a
 * reply comes or not, so a wedged channel reads as one.
 *
 * @param {{workerModel: ?Object, topologyModel: ?Object}} board The board.
 * @return {boolean} Whether it is.
 */
export function useConnected( { workerModel, topologyModel } ) {
	const lastSuccessRef = useRef( 0 );
	useEffect( () => {
		if ( workerModel || topologyModel ) {
			lastSuccessRef.current = Date.now();
		}
	}, [ workerModel, topologyModel ] );
	const pageVisible = usePageVisibility();
	const [ , bumpFreshness ] = useState( 0 );
	const bump = useCallback( () => bumpFreshness( ( n ) => n + 1 ), [] );
	useRouterTick( {
		name: 'freshness:timer',
		onTick: bump,
		intervalMs: BOARD_MS,
	} );
	return deriveConnected( {
		topologyError: Boolean( topologyModel?.error ),
		workerError: Boolean( workerModel?.error ),
		lastPollMs: lastSuccessRef.current,
		now: Date.now(),
		refreshMs: BOARD_MS,
		pageVisible,
	} );
}

/**
 * The fleet board and its three mutations.
 *
 * @param {Object}                       [opts]           Options.
 * @param {(r: TopologyRefusal) => void} [opts.onError]   Called with each refused
 *                                                        mutation, a tick later,
 *                                                        naming the topology.
 * @param {(r: TopologyRefusal) => void} [opts.onWarning] Called with each mutation
 *                                                        that succeeded with a
 *                                                        warning.
 * @return {ReturnType<typeof useTopologyBoard> & {
 *   activate: (name: string) => void,
 *   deactivate: (name: string) => void,
 *   restart: (name: string, partition?: number) => void }}
 *   The board and the three mutation commands.
 */
export function useTopologyManager( opts = {} ) {
	const board = useTopologyBoard();
	const onErrorRef = useRef( opts.onError );
	onErrorRef.current = opts.onError;
	const onWarningRef = useRef( opts.onWarning );
	onWarningRef.current = opts.onWarning;
	const { refresh } = board;

	/**
	 * Report a refused mutation, or the warning a successful one carries.
	 * The interpreter echoes the command's arguments, so `args[ 0 ]` is the
	 * topology the answer is about.
	 *
	 * @param {{error: ?string, result: ?Object, args: string[]}} reply One answer.
	 */
	const onMutationDone = useCallback(
		( { error, result, args } ) => {
			refresh();
			if ( error ) {
				onErrorRef.current?.( { name: args[ 0 ], message: error } );
			} else if ( result?.warning ) {
				onWarningRef.current?.( {
					name: args[ 0 ],
					message: result.warning,
				} );
			}
		},
		[ refresh ]
	);
	const { run: runRestart } = useCommandOnce( {
		group: BOARD_GROUP,
		ci: WORKERS_CI,
		command: 'restart',
		sendsOnRemoval: true,
		onDone: onMutationDone,
	} );
	const { run: runActivate } = useCommandOnce( {
		group: BOARD_GROUP,
		ci: TOPOLOGIES_CI,
		command: 'activate',
		sendsOnRemoval: true,
		onDone: onMutationDone,
	} );
	const { run: runDeactivate } = useCommandOnce( {
		group: BOARD_GROUP,
		ci: TOPOLOGIES_CI,
		command: 'deactivate',
		sendsOnRemoval: true,
		onDone: onMutationDone,
	} );

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

	return { ...board, activate, deactivate, restart };
}

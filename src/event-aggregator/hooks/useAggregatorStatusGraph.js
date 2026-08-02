/* global localStorage */
/**
 * useAggregatorStatusGraph — the de-god Aggregator Status data graph as a GENUINE
 * node graph on the substrate batched-poll toolkit (useBatchedPoll +
 * addSliceFetcher). The single `status` god poll feeding one `aggregator:view`
 * god view is gone; in its place two independent per-concern slice paths:
 *
 *   <tee> → fetch-summary (Fetcher, FROM=summaryIn) → _shell/_http/aggregator
 *           summaryIn (Tee) → summary:view (AggregatorSummaryView)
 *   <tee> → fetch-servers (Fetcher, FROM=serversIn) → _shell/_http/aggregator
 *           serversIn (Tee) → servers:view (AggregatorServersView)
 *
 * useBatchedPoll owns the Timer/Tee/_shell/_http + the lock-flush batching (so
 * both slices ride ONE HttpOut POST per tick) + the page-visibility gate; the
 * `_shell` Tap in front of `_http` makes every command going out inspectable.
 * The server CI replies TO=FROM=<receiver>, so each slice's reply lands ONLY on
 * its own receiver Tee → view — an independent reply path, nothing crosses. That
 * decomposition is the whole point of the de-god.
 *
 * Each slice verb (`summary`, `servers_status`) is read-only and cheap; both poll
 * unconditionally on the user-chosen interval. The only pause is useBatchedPoll's
 * page-visibility gate, which suspends polling on a HIDDEN tab.
 *
 * The command boundary is injectable: tests pass `opts.commandClient` (assigned
 * to `_http.client`); production lets HttpOut default it.
 *
 * Alongside the polled slices it serves the on-demand deep probe, and there the
 * same principle decides the shape: each spoke gets its OWN `aggregator:probe:<id>`
 * Request node. One shared node would have to tell N roll-ups apart — which is
 * the correlator this design does not have — so it is a node each, and the reply
 * that lands on one IS that spoke's answer. They ride `_http` directly (unlocked
 * between poll ticks → immediate POST; during a tick they batch with the poll).
 *
 * Returns the refresh control (`setRefreshInterval` / `refreshInterval`), the
 * `probe(id)` dispatch, and the per-spoke `probes` map it fills. React reads each
 * polled slice via its own useNodeState('<slice>:view','view').
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { formatCommandArgs } from '@newspack-nodes/runtime';
import { ensureRequestNode } from '@newspack-nodes/shared/hooks/useRequestNode';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';

// Server CI mount + egress path the Fetchers target (owns _shell/_http).
const SERVER = 'aggregator';
const TARGET = `_shell/_http/${ SERVER }`;

// One on-demand probe node per spoke; the name IS the addressing.
const PROBE_PREFIX = 'aggregator:probe';

// Refresh-interval options offered to the user (the select in the dashboard).
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

const DEFAULT_REFRESH_MS = '2000';
const REFRESH_KEY = 'aggregator-status-refresh';

/**
 * Resolve the initial refresh interval from localStorage (matches the old
 * AggregatorStatus useState initializer).
 *
 * @return {string} A valid REFRESH_OPTIONS value, or DEFAULT_REFRESH_MS.
 */
function initialRefresh() {
	const validValues = REFRESH_OPTIONS.map( ( opt ) => opt.value );
	const saved = localStorage.getItem( REFRESH_KEY );
	if ( saved && validValues.includes( saved ) ) {
		return saved;
	}
	return DEFAULT_REFRESH_MS;
}

// Two slices; each a Fetcher → receiver Tee → view with its own reply path.
const SLICES = [
	{
		fetcher: 'fetch-summary',
		receiver: 'summaryIn',
		command: 'summary',
		view: 'summary:view',
		viewClass: 'AggregatorSummaryView',
	},
	{
		fetcher: 'fetch-servers',
		receiver: 'serversIn',
		command: 'servers_status',
		view: 'servers:view',
		viewClass: 'AggregatorServersView',
	},
];

/**
 * @param {Object} [opts]               Options (testing seams).
 * @param {Object} [opts.commandClient] transport seam assigned to `_http.client`;
 *                                      defaults (inside HttpOut) to the localized transport.
 * @return {{ setRefreshInterval: Function, refreshInterval: string }} Control
 *   callbacks for the thin React view (each slice is read via useNodeState).
 */
export function useAggregatorStatusGraph( opts = {} ) {
	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] =
		useState( initialRefresh );

	// De-god poll graph: each slice its own Fetcher→Tee→view; one POST/tick.
	useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, {
					...slice,
					tee,
					target: TARGET,
				} )
			);
			// On-demand fleet-probe reply edge: receiver Tee → result view.
		},
		timerName: 'aggregator:timer',
		teeName: 'aggregator:tee',
		commandClient: opts.commandClient,
		// Refresh value (ms) = poll cadence; >1s hitchhikes TIMER, re-arms.
		intervalMs: parseInt( refreshInterval, 10 ) || 0,
	} );

	// Per-spoke roll-ups, filed as each probe settles.
	const [ probes, setProbes ] = useState( {} );

	// On-demand deep probe of one spoke, through that spoke's own node.
	const probe = useCallback( async ( id ) => {
		const node = ensureRequestNode( `${ PROBE_PREFIX }:${ id }`, SERVER );
		if ( ! node ) {
			return Promise.reject( new Error( 'graph not mounted' ) );
		}
		try {
			const rollup = await node.request(
				'probe',
				formatCommandArgs( [ id ] )
			);
			setProbes( ( prev ) => ( {
				...prev,
				[ id ]: { ok: true, rollup },
			} ) );
			return rollup;
		} catch ( e ) {
			setProbes( ( prev ) => ( {
				...prev,
				[ id ]: { ok: false, error: e?.message ?? 'Probe failed' },
			} ) );
			throw e;
		}
	}, [] );

	// Persist the refresh choice to localStorage.
	useEffect( () => {
		localStorage.setItem( REFRESH_KEY, refreshInterval );
	}, [ refreshInterval ] );

	// Change the refresh interval; useBatchedPoll's effect re-paces.
	const setRefreshInterval = ( value ) => {
		setRefreshIntervalState( value );
	};

	return { setRefreshInterval, refreshInterval, probe, probes };
}

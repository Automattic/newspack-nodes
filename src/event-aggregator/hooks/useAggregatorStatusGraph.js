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
 * unconditionally on the user-chosen interval (the old AggregatorStatus polled
 * unconditionally, and useBatchedPoll's page-visibility gate only pauses a HIDDEN
 * tab — the same effect the old code never opted out of).
 *
 * The command boundary is injectable: tests pass `opts.commandClient` (assigned
 * to `_http.client`); production lazily defaults to the shared CommandClient.
 *
 * Returns ONLY the refresh control (`setRefreshInterval` / `refreshInterval`);
 * React reads each slice via its own useNodeState('<slice>:view','view').
 */

import { useEffect, useState } from '@wordpress/element';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';

// The server CI mount + the egress path the Fetchers target (useBatchedPoll owns
// `_shell`/`_http`; the caller names the server CI mount).
const SERVER = 'aggregator';
const TARGET = `_shell/_http/${ SERVER }`;

// Refresh-interval options offered to the user (the select in the dashboard).
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

export const DEFAULT_REFRESH_MS = '2000';
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

// The two per-concern slices: the header summary (counts + clock) and the
// server-cards data. Each is one Fetcher → receiver Tee → view; addSliceFetcher
// wires the inspectable reply path per slice.
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
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults (inside useBatchedPoll) to a freshly-constructed CommandClient.
 * @return {{ setRefreshInterval: Function, refreshInterval: string }} Control
 *   callbacks for the thin React view (each slice is read via useNodeState).
 */
export function useAggregatorStatusGraph( opts = {} ) {
	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] =
		useState( initialRefresh );

	// The de-god poll graph: each slice as an independent Fetcher → receiver Tee →
	// view path on the shared batched-poll backbone. useBatchedPoll owns the
	// Timer/Tee/_shell/_http + lock-flush; both slices ride one POST per tick.
	useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, {
					...slice,
					tee,
					target: TARGET,
				} )
			);
		},
		timerName: 'aggregator:timer',
		teeName: 'aggregator:tee',
		commandClient: opts.commandClient,
		// The refresh selector's value (ms string) becomes the poll cadence: > 1s
		// hitchhikes the router TIMER and throttles to it; changing it re-arms.
		intervalMs: parseInt( refreshInterval, 10 ) || 0,
	} );

	// Persist the refresh choice (matches the old save-to-localStorage effect).
	useEffect( () => {
		localStorage.setItem( REFRESH_KEY, refreshInterval );
	}, [ refreshInterval ] );

	// Change + persist the refresh interval; useBatchedPoll's interval effect re-paces.
	const setRefreshInterval = ( value ) => {
		setRefreshIntervalState( value );
	};

	return { setRefreshInterval, refreshInterval };
}

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
 * Nothing is injected: HttpOut lazily defaults its own client, and tests seam
 * at `fetch` (`installFakeCommandWire`) so the whole egress runs for real.
 * Alongside the polled slices it serves the on-demand deep probe, and there the
 * same principle decides the shape: each spoke gets its OWN `aggregator:probe:<id>`
 * Request node. One shared node would have to tell N roll-ups apart — which is
 * the correlator this design does not have — so it is a node each, and the reply
 * that lands on one IS that spoke's answer. They take the same
 * `_shell/_http/<ci>` path as the slices (unlocked between poll ticks →
 * the same tick as the poll), and the answer names the spoke it is about.
 *
 * Returns the refresh control (`setRefreshInterval` / `refreshInterval`), the
 * `probe(id)` dispatch, and `answerFor(id)` — which asks the probe's own node
 * whether its outstanding command or its last reply was about that spoke. React reads each
 * polled slice via its own useNodeState('<slice>:view','view').
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { formatCommandArgs } from '@newspack-nodes/runtime';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { views } from '../nodes/register';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

// Server CI mount + egress path the Fetchers target (owns _shell/_http).
const SERVER = 'aggregator';
const TARGET = egressPath( SERVER );

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
		viewClass: views.AggregatorSummaryView,
	},
	{
		fetcher: 'fetch-servers',
		receiver: 'serversIn',
		command: 'servers_status',
		view: 'servers:view',
		viewClass: views.AggregatorServersView,
	},
];

/**
 * @return {{ setRefreshInterval: ( value: string ) => void, refreshInterval: string, probe: ( id: string ) => void, answerFor: ( id: string ) => ?Object }}
 *   The controls the thin React view needs: `setRefreshInterval` takes a
 *   REFRESH_OPTIONS value (string ms), `probe` deep-probes one spoke by id and
 *   returns nothing — `answerFor( id )` reports what came back for the
 *   settled result of that spoke's last probe. Each polled slice is read
 *   separately via useNodeState.
 */
export function useAggregatorStatusGraph() {
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
		},
		timerName: 'aggregator:timer',
		teeName: 'aggregator:tee',
		// Refresh value (ms) = poll cadence; >1s hitchhikes TIMER, re-arms.
		intervalMs:
			parseInt( refreshInterval, 10 ) ||
			parseInt( DEFAULT_REFRESH_MS, 10 ),
	} );

	// On-demand deep probe, filed under the spoke its arguments name.
	const { run: runProbe, answerFor } = useCommandOnce( {
		ci: SERVER,
		command: 'probe',
		scope: PROBE_PREFIX,
	} );
	const probe = useCallback(
		( id ) => runProbe( formatCommandArgs( [ id ] ) ),
		[ runProbe ]
	);

	// Persist the refresh choice to localStorage.
	useEffect( () => {
		localStorage.setItem( REFRESH_KEY, refreshInterval );
	}, [ refreshInterval ] );

	// Change the refresh interval; useBatchedPoll's effect re-paces.
	const setRefreshInterval = ( value ) => {
		setRefreshIntervalState( value );
	};

	return { setRefreshInterval, refreshInterval, probe, answerFor };
}

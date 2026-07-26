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
 * to `_http.client`); production lazily defaults to the shared CommandClient.
 *
 * Alongside the polled slices it wires ONE on-demand concern — a `aggregator:fleet`
 * result view behind its own `aggregator:fleetIn` receiver Tee — and returns a
 * `probe(id)` that POSTs the `probe` verb (deep spoke roll-up) and settles when
 * the reply lands on that view. It rides `_http` directly (unlocked between poll
 * ticks → immediate POST; during a tick it batches with the poll).
 *
 * Returns the refresh control (`setRefreshInterval` / `refreshInterval`) + the
 * `probe(id)` dispatch; React reads each slice via its own
 * useNodeState('<slice>:view','view') and the fleet via
 * useNodeState('aggregator:fleet','view').
 */

import { markLocal } from '../../runtime/command-auth';
import { useCallback, useEffect, useState } from '@wordpress/element';
import {
	Core,
	newMessage,
	TYPE,
	TO,
	FROM,
	ID,
	VALUE,
	TM_COMMAND,
	formatCommandArgs,
} from '@newspack-nodes/runtime';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';

// Server CI mount + egress path the Fetchers target (owns _shell/_http).
const SERVER = 'aggregator';
const TARGET = `_shell/_http/${ SERVER }`;

// On-demand deep-probe concern: receiver Tee + result view, keyed by server id.
const FLEET_RECV = 'aggregator:fleetIn';
const FLEET_VIEW = 'aggregator:fleet';

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
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`;
 *                                      defaults (inside useBatchedPoll) to a freshly-constructed CommandClient.
 * @return {{ setRefreshInterval: Function, refreshInterval: string }} Control
 *   callbacks for the thin React view (each slice is read via useNodeState).
 */
export function useAggregatorStatusGraph( opts = {} ) {
	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshIntervalState ] =
		useState( initialRefresh );

	// De-god poll graph: each slice its own Fetcher→Tee→view; one POST/tick.
	const { interpreterRef } = useBatchedPoll( {
		build: ( { interpreter, tee } ) => {
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, {
					...slice,
					tee,
					target: TARGET,
				} )
			);
			// On-demand fleet-probe reply edge: receiver Tee → result view.
			const fleetIn = interpreter.makeNode( 'Tee', FLEET_RECV );
			interpreter.makeNode( 'AggregatorFleetView', FLEET_VIEW );
			fleetIn.connectNode( FLEET_VIEW );
		},
		timerName: 'aggregator:timer',
		teeName: 'aggregator:tee',
		commandClient: opts.commandClient,
		// Refresh value (ms) = poll cadence; >1s hitchhikes TIMER, re-arms.
		intervalMs: parseInt( refreshInterval, 10 ) || 0,
	} );

	// On-demand deep probe of one spoke; settles via the fleet replies map.
	const probe = useCallback(
		( id ) => {
			const interpreter = interpreterRef.current;
			if ( ! interpreter ) {
				return Promise.reject( new Error( 'graph not mounted' ) );
			}
			const view = Core.node( FLEET_VIEW );
			if ( ! view ) {
				return Promise.reject( new Error( 'fleet view not mounted' ) );
			}
			const promise = new Promise( ( resolve, reject ) => {
				view.replies.add( id, resolve, reject );
			} );
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ FROM ] = FLEET_RECV;
			m[ TO ] = TARGET;
			m[ ID ] = id;
			m[ VALUE ] = {
				name: 'probe',
				arguments: formatCommandArgs( [ id ] ),
			};
			markLocal( m );
			interpreter.fill( m );
			return promise;
		},
		[ interpreterRef ]
	);

	// Persist the refresh choice to localStorage.
	useEffect( () => {
		localStorage.setItem( REFRESH_KEY, refreshInterval );
	}, [ refreshInterval ] );

	// Change the refresh interval; useBatchedPoll's effect re-paces.
	const setRefreshInterval = ( value ) => {
		setRefreshIntervalState( value );
	};

	return { setRefreshInterval, refreshInterval, probe };
}

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
 * same principle decides the shape: ONE probe node serves every card, because
 * the SUBJECT rides in the ADDRESS. A probe of `spoke-01` is minted FROM
 * `aggregator:probe:in/spoke-01`; the server echoes TO = FROM; the Router peels
 * `aggregator:probe:in` off and the answer arrives there carrying `spoke-01` as
 * its remaining TO. So the reply says which spoke it is about without an id, a
 * table, or a node per card ([ADR-7](../../../docs/architecture-decisions.md)).
 *
 * Returns the refresh control (`setRefreshInterval` / `refreshInterval`) and
 * `probeServer`; each probe answer reaches the caller through `onAnswer`,
 * naming its spoke. React reads each polled slice via its own
 * useNodeState('<slice>:view','view').
 */

import { useCallback } from '@wordpress/element';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { usePersistedChoice } from '@newspack-nodes/shared/hooks/usePersistedState';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { formatCommandArgs } from '../../runtime/command-args';
import { views } from '../nodes/register';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

// Server CI mount + egress path the Fetchers target (owns _shell/_http).
const SERVER = 'aggregator';
const TARGET = egressPath( SERVER );

// Refresh-interval options offered to the user (the select in the dashboard).
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

// One probe node for the whole fleet; the subject rides in the reply path.
const PROBE_SCOPE = 'aggregator:probe';

const DEFAULT_REFRESH_MS = '2000';
const REFRESH_KEY = 'aggregator-status-refresh';

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
 * @param {Object}   [o]
 * @param {Function} [o.onAnswer] `( { subject, result, error } )` — once per
 *                                probe reply, naming the spoke it was about.
 * @return {{ setRefreshInterval: ( value: string ) => void, refreshInterval: string, probeServer: ( id: string ) => void, isPending: ( id: string ) => boolean }}
 *   `setRefreshInterval` takes a REFRESH_OPTIONS value (string ms). Each polled
 *   slice is read separately via useNodeState.
 */
export function useAggregatorStatusGraph( { onAnswer } = {} ) {
	// The persisted refresh interval (string ms); seeds from localStorage.
	const [ refreshInterval, setRefreshInterval ] = usePersistedChoice(
		REFRESH_KEY,
		REFRESH_OPTIONS,
		DEFAULT_REFRESH_MS
	);

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

	// ONE deep probe for every card; the reply names the spoke it answered.
	const probe = useCommandOnce( {
		ci: SERVER,
		command: 'probe',
		scope: PROBE_SCOPE,
		onDone: ( { subject, result, error } ) =>
			onAnswer?.( { subject, result, error } ),
	} );
	const { run: runProbe, isPending } = probe;

	// cmd_probe wants the vault credential key, not the node name.
	const probeServer = useCallback(
		( vaultId ) => runProbe( formatCommandArgs( [ vaultId ] ) ),
		[ runProbe ]
	);

	return { setRefreshInterval, refreshInterval, probeServer, isPending };
}

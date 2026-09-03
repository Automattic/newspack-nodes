/**
 * useAggregatorStatusGraph — the Aggregator Status screen as a node graph: two
 * independently polled slices and one on-demand probe, built on the substrate's
 * batched-poll toolkit (`useBatchedPoll` + `addSliceFetcher`).
 *
 *   <tee> → fetch-summary (Fetcher, FROM=summaryIn) → _shell/_http/aggregator
 *           summaryIn (Tee) → summary:view (AggregatorSummaryView)
 *   <tee> → fetch-servers (Fetcher, FROM=serversIn) → _shell/_http/aggregator
 *           serversIn (Tee) → servers:view (AggregatorServersView)
 *
 * `useBatchedPoll` owns everything that is not a slice: the Timer, the fan-out
 * Tee, the `_shell`/`_http` egress, the lock-flush batching that puts both
 * slices in ONE HttpOut POST per tick, and the page-visibility gate that
 * suspends polling on a hidden tab. The `_shell` Tap in front of `_http` is
 * what lets the console watch every command this screen sends.
 *
 * The server CI replies TO=FROM, so each slice's reply lands on its own
 * receiver Tee and travels its own path to its own view: an answer to `summary`
 * never touches `servers:view`. The rejected alternative is one `status` verb
 * feeding one view node, which makes the server compute the whole model to
 * answer any part of it and re-renders every card on every field.
 *
 * Both slice verbs (`summary`, `servers_status`) are READ and cheap, so they
 * poll unconditionally on the user-chosen interval. `probe` blocks on a request
 * to the spoke and demands MANAGE, so it goes out only on a click.
 *
 * ONE probe node serves every card, because the SUBJECT rides in the ADDRESS. A
 * probe of `spoke-01` is minted FROM `aggregator:probe:in/spoke-01`; the server
 * echoes TO = FROM; the Router peels `aggregator:probe:in` off and the answer
 * arrives there carrying `spoke-01` as its remaining TO. So the reply says which
 * spoke it is about without an id, a correlation table, or a node per card
 * ([ADR-7](../../../docs/architecture-decisions.md)).
 *
 * Nothing is injected: HttpOut lazily defaults its own client, and tests seam at
 * `fetch` (`installFakeCommandWire`), so packing, the egress, the Router and the
 * interpreter all run for real.
 *
 * React reads each polled slice through its own `useNodeState( '<slice>:view',
 * 'view' )`; only the refresh control and the probe come back from this hook.
 */

import { useCallback } from '@wordpress/element';
import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { usePersistedChoice } from '@newspack-nodes/shared/hooks/usePersistedState';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { formatCommandArgs } from '../../runtime/command-args';
import { views } from '../nodes/register';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';

/** The server CI mount owning `summary`, `servers_status` and `probe`. */
const SERVER = 'aggregator';

/**
 * The egress path both Fetchers target: out through the observe-only `_shell`
 * Tap, then the `_http` HttpOut, then the server CI mount. `useBatchedPoll`
 * provides the first two; naming the mount is this hook's half.
 */
const TARGET = egressPath( SERVER );

/**
 * The cadences the dashboard's dropdown offers, as milliseconds in string form
 * because `usePersistedChoice` matches stored text against each option's own
 * value. Every one clears the 1000ms floor `useBatchedPoll` enforces: below it
 * the Timer takes a slot outside the Router's lock and flush, which costs one
 * POST per slice instead of one per tick.
 */
export const REFRESH_OPTIONS = [
	{ label: '1s', value: '1000' },
	{ label: '2s', value: '2000' },
	{ label: '5s', value: '5000' },
	{ label: '10s', value: '10000' },
];

/**
 * Names the probe's own nodes. One node for the whole fleet; the spoke it
 * answers about rides in the reply's address — see the module overview.
 */
const PROBE_SCOPE = 'aggregator:probe';

/** The cadence a first visit polls at, as a REFRESH_OPTIONS value. */
const DEFAULT_REFRESH_MS = '2000';

/** The localStorage key the chosen cadence outlives the page under. */
const REFRESH_KEY = 'aggregator-status-refresh';

/**
 * One entry per slice: the Fetcher that asks, the receiver Tee its reply pivots
 * back to, the verb it asks for, and the view node the reply lands on. A third
 * slice is an entry here and a widget; the poll itself does not change.
 */
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
 * Mount the Aggregator Status graph, poll both slices, and serve the probe.
 *
 * @param {Object}   [o]          Caller options.
 * @param {Function} [o.onAnswer] `( { subject, result, error } ) => void`, run
 *                                once per probe reply. `subject` is the Vault id
 *                                the answer is about, read off its address.
 * @return {{setRefreshInterval: (value: string) => void, refreshInterval: string, probeServer: (vaultId: string) => void, isPending: (vaultId: string) => boolean}}
 *   `refreshInterval` and `setRefreshInterval` carry a REFRESH_OPTIONS value
 *   (milliseconds as a string). `isPending` answers per spoke, so probing one
 *   card leaves every sibling card's button alone.
 */
export function useAggregatorStatusGraph( { onAnswer } = {} ) {
	// The chosen cadence, milliseconds as a string; seeded from storage.
	const [ refreshInterval, setRefreshInterval ] = usePersistedChoice(
		REFRESH_KEY,
		REFRESH_OPTIONS,
		DEFAULT_REFRESH_MS
	);

	// One Fetcher, receiver Tee and view per slice; one POST per tick.
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
		// The chosen cadence IS the poll cadence, in whole milliseconds.
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

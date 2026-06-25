/**
 * usePublisherInsightsGraph — the Publisher Insights dashboard as a GENUINE node
 * graph, now built from the substrate's batched-poll toolkit:
 *
 *   insights:timer (Timer) ─> insights:tee (Tee) ─> fetch-counts (Fetcher) ─┐
 *                                                 ├> fetch-top    (Fetcher) ─┤  target = _shell/_http/insights-demo
 *                                                 └> fetch-acc    (Fetcher) ─┘
 *   countsIn (Tee) ─> source-counts:view ─> <SourceCounts/>
 *   topIn    (Tee) ─> top-table:view     ─> <TopTable/>
 *   accIn    (Tee) ─> accumulated:view   ─> <AccumulatedCard/>
 *
 * `useBatchedPoll` (helper H3) owns ALL the poll boilerplate that used to be
 * hand-wired here: the `_shell`-Tap + `_http` HttpOut, the fan-out Tee + the
 * router-hitchhike Timer, the lock/flush bracket (so a tick's three fetcher
 * commands batch into ONE HttpOut POST — fan-out is free), and the page-
 * visibility gate (HIDDEN unregisters the Timer → no POST; VISIBLE re-registers
 * it). All this hook supplies is its slices: `addSliceFetcher` (helper H4) wires
 * each Fetcher → `_shell/_http/insights-demo`, its receiver Tee, and its view
 * node — an independent reply path per slice. The command boundary is injectable
 * via `opts.commandClient` so tests never touch the network.
 */

import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';

// The server-side CI mount this example owns (the real product owns unsuffixed
// `insights`). The Fetchers target it through the substrate's `_shell/_http`.
const SERVER = 'insights-demo';
const TARGET = `_shell/_http/${ SERVER }`;

// Per-slice fetcher config: the receiver Tee a reply pivots back to, the verb,
// and the view node (+ its registered class) the reply lands on.
const SLICES = [
	{
		fetcher: 'fetch-counts',
		receiver: 'countsIn',
		command: 'counts',
		view: 'source-counts:view',
		viewClass: 'SourceCountsView',
	},
	{
		fetcher: 'fetch-top',
		receiver: 'topIn',
		command: 'top',
		view: 'top-table:view',
		viewClass: 'TopTableView',
	},
	{
		fetcher: 'fetch-acc',
		receiver: 'accIn',
		command: 'accumulated',
		view: 'accumulated:view',
		viewClass: 'AccumulatedView',
	},
];

/**
 * @param {Object} [opts]               Options (test seams).
 * @param {Object} [opts.commandClient] CommandClient seam assigned to `_http.client`.
 */
export function usePublisherInsightsGraph( opts = {} ) {
	useBatchedPoll( {
		build: ( { interpreter, tee } ) =>
			SLICES.forEach( ( slice ) =>
				addSliceFetcher( interpreter, {
					...slice,
					tee,
					target: TARGET,
				} )
			),
		timerName: 'insights:timer',
		teeName: 'insights:tee',
		commandClient: opts.commandClient,
	} );
}

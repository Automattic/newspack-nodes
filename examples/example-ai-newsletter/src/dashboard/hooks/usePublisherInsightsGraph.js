/**
 * Mount the Publisher Insights dashboard as a node graph and poll it: one
 * Timer, one fan-out Tee, and one Fetcher per card, each card's reply
 * travelling its own path back to its own view node.
 *
 *   insights:timer (Timer) ─> insights:tee (Tee) ─┬> fetch-counts (Fetcher) ─┐
 *                                                 ├> fetch-top    (Fetcher) ─┤  target = _shell/_http/insights-demo
 *                                                 └> fetch-acc    (Fetcher) ─┘
 *   countsIn (Tee) ─> source-counts:view ─> <SourceCounts/>
 *   topIn    (Tee) ─> top-table:view     ─> <TopTable/>
 *   accIn    (Tee) ─> accumulated:view   ─> <AccumulatedCard/>
 *
 * One view node behind a single omnibus verb would be the god object: every
 * card re-renders on every field, and the server computes the whole model to
 * answer any part of it. Here the counts reply never touches the top table.
 *
 * Each Fetcher stamps FROM with its receiver Tee and the service CI replies
 * TO=FROM, so the address is the correlation and no slice needs an operation
 * id or a promise registry (ADR-7).
 *
 * `useBatchedPoll` owns everything that is not a slice: the exospine mount that
 * brings the `_shell` Tap and the `_http` HttpOut, the fan-out Tee, the
 * router-hitchhike Timer, and the page-visibility gate that unregisters the
 * Timer while the tab is hidden. The Router, not this hook, brackets each tick
 * with the `_http` lock and flush, so the tick's three commands leave as ONE
 * POST — a fourth slice costs no extra request.
 *
 * Tests drive the graph through `global.fetch` (`installFakeCommandWire`), so
 * packing, HttpOut, the Router and the interpreter all run for real.
 */

import { useBatchedPoll } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import '../nodes/register';
import { SourceCountsViewNode } from '../nodes/source-counts-view-node';
import { TopTableViewNode } from '../nodes/top-table-view-node';
import { AccumulatedViewNode } from '../nodes/accumulated-view-node';

/**
 * The service CI mount the Fetchers address. The `-demo` suffix is what lets
 * this example run beside `newspack-intelligence`, which mounts the unsuffixed
 * `insights` in the same WordPress.
 */
const SERVER = 'insights-demo';

/**
 * Poll cadence, in milliseconds. All three cards read one committed offsetlog
 * snapshot, which moves only when the pipeline commits, so thirty seconds is a
 * retry rather than a feed. `useBatchedPoll` throws below 1000ms: under that
 * floor a Timer takes its own `setInterval` slot and fires outside the Router's
 * lock and flush, which costs one POST per slice instead of one per tick.
 */
const DEFAULT_INTERVAL_MS = 30000;

/**
 * The egress path every Fetcher targets — out through the observe-only
 * `_shell` Tap, then the `_http` HttpOut, then the server CI. Going through
 * `_shell` rather than straight to `_http` is what lets `connect _shell` in the
 * console watch every command leaving the page.
 *
 * `egressPath( SERVER )` from `@newspack-nodes/shared/helpers/egressPath`
 * composes the same string. A dashboard outside this tutorial calls it rather
 * than respelling two reserved names.
 */
const TARGET = `_shell/_http/${ SERVER }`;

/**
 * One entry per card: the Fetcher that asks, the receiver Tee a reply pivots
 * back to, the verb it asks for, and the view node the reply lands on. A fourth
 * card is an entry here and a widget; the poll itself does not change.
 *
 * `viewClass` carries the CLASS, never its registered name. The name table is a
 * per-bundle static (ADR-16), so a name resolves only through an interpreter
 * this bundle mounted, and a hub tab building the graph through another
 * bundle's interpreter would find nothing. `../nodes/register` still runs, for
 * the TSL and console-palette lookups that have no class to hand.
 */
const SLICES = [
	{
		fetcher: 'fetch-counts',
		receiver: 'countsIn',
		command: 'counts',
		view: 'source-counts:view',
		viewClass: SourceCountsViewNode,
	},
	{
		fetcher: 'fetch-top',
		receiver: 'topIn',
		command: 'top',
		view: 'top-table:view',
		viewClass: TopTableViewNode,
	},
	{
		fetcher: 'fetch-acc',
		receiver: 'accIn',
		command: 'accumulated',
		view: 'accumulated:view',
		viewClass: AccumulatedViewNode,
	},
];

/**
 * Mount the Publisher Insights graph and start polling it.
 *
 * @param {Object} [opts]            Caller overrides.
 * @param {number} [opts.intervalMs] Poll cadence in ms; 1000 or greater.
 * @return {void} Each widget reads its own slice through `useNodeState`.
 * @throws {TypeError} When `opts.intervalMs` is below the 1000ms floor.
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
		intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
	} );
}

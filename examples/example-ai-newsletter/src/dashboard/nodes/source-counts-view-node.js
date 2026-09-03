import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The `source-counts:view` node, which owns the Publisher Insights dashboard's
 * per-source counts slice and nothing else. `<SourceCounts/>` reads what it
 * publishes through `useNodeState( 'source-counts:view', 'view' )`.
 *
 * The `counts` verb on `Insights_CI_Demo_Node` answers
 * `{ sources: { <source>: <count> } }`, which is already the render model, so
 * this view inherits `SliceViewNode`'s JSON parse unchanged and declares only
 * the empty shape.
 *
 * The slice gets a node of its own because the reply is addressed rather than
 * correlated (ADR-7): the Fetcher stamps `FROM = countsIn`, the CI replies
 * `TO = FROM`, and the `countsIn` Tee fans that reply to this view alone. One
 * node holding counts, top and accumulated would have to tell three replies
 * apart, and a `top` failure would blank the counts card with it.
 *
 * `register.js` registers the class as `SourceCountsView`, the name
 * `usePublisherInsightsGraph` hands `addSliceFetcher` as its `viewClass`.
 */
export class SourceCountsViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty counts model, published from the base constructor so
	 * a render before the first reply is valid. `<SourceCounts/>` reads the
	 * empty map as its "No sources yet" hint, so an unanswered dashboard shows
	 * the card rather than nothing.
	 *
	 * @return {{sources: Object<string,number>}} Source name to item count.
	 */
	emptySlice() {
		return { sources: {} };
	}
}

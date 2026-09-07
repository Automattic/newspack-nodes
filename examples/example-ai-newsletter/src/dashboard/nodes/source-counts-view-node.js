import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The `source-counts:view` node, which owns the Publisher Insights dashboard's
 * per-source counts slice and nothing else. `<SourceCounts/>` reads what it
 * publishes through `useNodeState( 'source-counts:view', 'view' )`.
 *
 * The `counts` verb on `Insights_CI_Demo_Node` answers
 * `{ sources: { <source>: <count> } }` as JSON, which is already the render
 * model, so this view inherits `SliceViewNode`'s parse unchanged and declares
 * only the empty shape.
 *
 * The slice gets a node of its own because the reply is addressed rather than
 * correlated (ADR-7): the `fetch-counts` Fetcher stamps `FROM = countsIn`, the
 * CI answers `TO = FROM`, and the `countsIn` Tee fans that reply to this view
 * and back to the Fetcher, which settles the ask — never to a sibling slice.
 * One node holding counts, top and accumulated would have to tell three replies
 * apart, and a `top` failure would put its error where the counts bars are.
 *
 * `usePublisherInsightsGraph` hands `addSliceFetcher` this class itself as the
 * slice's `viewClass`, because the name table is a per-bundle static (ADR-16).
 * `register.js` registers it as `SourceCountsView` for the text paths that have
 * only a name to resolve: TSL and the console palette.
 *
 * A view whose whole content is an empty-model literal is a `sliceView()`
 * declaration in a real dashboard. This one is written out as a class because
 * `docs/writing-a-dashboard.md` teaches that form before the shorthand.
 */
export class SourceCountsViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty counts model, published from the base constructor so
	 * a render before the first reply is valid. `<SourceCounts/>` reads the
	 * empty map as its "No sources yet" hint, so an unanswered dashboard shows
	 * the card rather than nothing.
	 *
	 * It declares no `loading` or `error` field: a TM_ERROR reply adds `error`
	 * itself, which the card renders in place of the bars, and the next parsed
	 * reply drops it when the base rebuilds the model.
	 *
	 * @return {{sources: Object<string,number>}} Empty render model; the map is source name to item count.
	 */
	emptySlice() {
		return { sources: {} };
	}
}

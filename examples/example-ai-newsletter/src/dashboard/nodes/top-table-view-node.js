import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The `top-table:view` node, owner of the score-ranked top-items slice and
 * nothing else. `usePublisherInsightsGraph` gives it its own Fetcher and
 * receiver Tee for the `insights-demo` CI's `top` verb, so that reply lands
 * here and never touches the counts or accumulated slices, and `<TopTable/>`
 * reads the published model through `useNodeState( 'top-table:view', 'view' )`.
 *
 * The verb answers `{ top: [ { source, title, score } ] }` as JSON — at most
 * ten items, highest score first — and that IS the slice, so the base class's
 * parse needs no override and this class declares only its empty model.
 *
 * `register.js` registers the class as `TopTableView`, the name a TSL or
 * console `make_node` resolves. The console's class palette skips it: the
 * schema it inherits from `SliceViewNode` declares the `Hidden` category. The
 * dashboard graph hands `addSliceFetcher` the class itself instead, because
 * that name table is a per-bundle static (ADR-16).
 */
export class TopTableViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty slice, which the base publishes from the constructor
	 * so a render arriving before the first reply is valid — `<TopTable/>` reads
	 * its empty state off `top.length`.
	 *
	 * It declares no `loading` or `error` field: the card shows its "No scored
	 * items yet" hint rather than a spinner, and a TM_ERROR reply adds `error`
	 * on its own, which the next good reply drops when it rebuilds the model.
	 *
	 * @return {{top: Array<Object>}} Empty render model.
	 */
	emptySlice() {
		return { top: [] };
	}
}

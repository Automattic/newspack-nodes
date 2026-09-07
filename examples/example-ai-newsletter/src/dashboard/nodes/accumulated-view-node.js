import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `accumulated:view` — the terminal node owning the digest's item-count slice,
 * `{ accumulated: N }`, which `<AccumulatedCard/>` reads through
 * `useNodeState( 'accumulated:view', 'view' )`.
 *
 * N is the digest's current item count, not a lifetime total: every FLUSH
 * empties `Digest_Builder_Demo_Node`'s item list, so the tile drops to zero
 * after each draft and climbs again.
 *
 * The slice is the reply to `Insights_CI_Demo_Node`'s `accumulated` verb: the
 * `fetch-acc` Fetcher mints the command with FROM = `accIn`, the server answers
 * TO = FROM, and the `accIn` Tee fans that reply here. One slice per view is
 * what keeps a failed read off the sibling cards — a single view holding
 * `{ counts, top, accumulated }` would publish one slice's error to all three.
 *
 * The verb answers this slice as JSON and nothing reshapes it, so the base
 * class's `_parse()` stands and the empty model is all this class supplies.
 *
 * `register.js` registers the class as `AccumulatedView`, the name a TSL
 * `make_node` or the console palette resolves. The dashboard graph hands
 * `addSliceFetcher` the class itself instead, because that name table is a
 * per-bundle static (ADR-16).
 */
export class AccumulatedViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty slice the constructor publishes, so the card renders
	 * a zero tile before the first reply rather than nothing.
	 *
	 * It declares no `loading` or `error` field: a TM_ERROR reply adds `error`
	 * itself, which the card renders in place of the tile, and the next parsed
	 * reply drops it when the base rebuilds the model.
	 *
	 * @return {{accumulated: number}} Empty render model.
	 */
	emptySlice() {
		return { accumulated: 0 };
	}
}

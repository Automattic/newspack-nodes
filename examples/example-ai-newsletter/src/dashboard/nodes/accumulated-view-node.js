import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `accumulated:view` — the terminal node owning the digest's total-item slice,
 * `{ accumulated: N }`, which `<AccumulatedCard/>` reads through
 * `useNodeState( 'accumulated:view', 'view' )`.
 *
 * The slice is the reply to `Insights_CI_Demo_Node`'s `accumulated` verb: the
 * `fetch-acc` Fetcher mints the command with FROM = `accIn`, the server answers
 * TO = FROM, and the `accIn` Tee fans that reply here. One slice per view is
 * what keeps a failed count off the sibling cards — a single view holding
 * `{ counts, top, accumulated }` would publish one slice's error to all three.
 *
 * The verb answers this slice as JSON and nothing reshapes it, so the base
 * class's `_parse()` stands and the empty model is all this class supplies.
 */
export class AccumulatedViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty slice the constructor publishes, so the card renders
	 * a zero tile before the first reply rather than nothing.
	 *
	 * @return {{accumulated: number}} Empty render model.
	 */
	emptySlice() {
		return { accumulated: 0 };
	}
}

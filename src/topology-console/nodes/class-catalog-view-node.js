import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `classes:view` — the palette's class catalog, as a polled slice.
 *
 * It used to memoise the in-flight promise forever, so a catalog that failed
 * once stayed failed: every later load handed back the same rejected promise
 * and the palette stayed empty until a reload. The overnight tab hit exactly
 * that — loaded fine at mount, session expired an hour later, nothing ever
 * asked again. A slice has no promise to memoise; the tick asks again.
 */
export class ClassCatalogViewNode extends SliceViewNode {
	/**
	 * The shaped-but-empty catalog rendered before the first reply lands.
	 *
	 * @return {Object} Empty render model.
	 */
	emptySlice() {
		return { classes: null, formatters: [], error: null };
	}

	/**
	 * Keep the prior catalog unless BOTH lists are present: a partial body is
	 * the shape a half-built palette comes from, and the palette is better one
	 * tick stale than half-populated.
	 *
	 * @param {Object} payload The decoded `classes list` body.
	 * @return {?Object} The render model, or null to keep the prior slice.
	 */
	_parse( payload ) {
		if (
			! Array.isArray( payload?.classes ) ||
			! Array.isArray( payload?.formatters )
		) {
			return null;
		}
		return {
			classes: payload.classes,
			formatters: payload.formatters,
			error: null,
		};
	}
}

/**
 * The console's slice views, declared rather than subclassed.
 *
 * Each was a one-shot load behind a latch or a memoised promise, so a single
 * failure blocked its list for the life of the page — the palette empty, the
 * OPEN dialog empty, the vault_id dropdown empty, until a reload. Polled, the
 * tick IS the retry, and a bad reply keeps whatever is already on screen.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/** The view classes, handed to `makeNode` — a name is per-bundle. */
export const views = registerSliceViews( {
	// Both lists or nothing: half a palette is worse than one a tick stale.
	ClassCatalogView: {
		empty: { classes: null, formatters: [], error: null },
		parse: ( body ) =>
			Array.isArray( body?.classes ) && Array.isArray( body?.formatters )
				? {
						classes: body.classes,
						formatters: body.formatters,
						error: null,
				  }
				: null,
	},

	// The OPEN dialog's catalog; a save owes it no reload.
	TopologyListView: {
		empty: { topologies: null, userDir: '', error: null },
		parse: ( body ) =>
			Array.isArray( body?.topologies )
				? {
						topologies: body.topologies,
						userDir: body.user_dir || '',
						error: null,
				  }
				: null,
	},
} );

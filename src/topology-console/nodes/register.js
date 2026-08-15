/**
 * The console's slice views, declared rather than subclassed.
 *
 * Each was a one-shot load behind a latch or a memoised promise, so a single
 * failure blocked its list for the life of the page — the palette empty, the
 * OPEN dialog empty, the vault_id dropdown empty, until a reload. Polled, the
 * tick IS the retry, and a bad reply keeps whatever is already on screen.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/** The classes, for the tests that instantiate them. @testonly */
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

	// The vault_id dropdown, from the map `vault list` returns.
	VaultCatalogView: {
		empty: { vaults: null, loading: true, error: null },
		parse: ( body ) =>
			body && 'object' === typeof body
				? {
						vaults: Object.values( body ).map( ( v ) => ( {
							id: v.id,
							url: v.url ?? '',
						} ) ),
						loading: false,
						error: null,
				  }
				: null,
	},
} );

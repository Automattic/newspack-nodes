/**
 * The console's slice views, declared rather than subclassed.
 *
 * Each owns one polled catalog and nothing else: the palette's Node classes
 * and formatter names, and the OPEN dialog's saved topologies. Neither needs
 * more than an empty model and a guard-then-map parse, which is what
 * `sliceView()` takes as a declaration. Both verbs answer a decoded struct
 * rather than a JSON string, so neither declares `json`.
 *
 * A parse returns null on a shape it cannot use, keeping the slice already on
 * screen; the next tick is the retry. A stale list beats an empty one.
 */

import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * The view classes. `useCatalogs` hands `makeNode` the class itself rather than
 * its name, because the devtools hub mounts the console against an interpreter
 * from another bundle and `includeNodes` is a per-bundle static
 * ([ADR-16](../../../docs/architecture-decisions.md)). Registering the names
 * still serves TSL and the console palette.
 */
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

	// The rows or nothing; an empty user_dir means no writable directory.
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

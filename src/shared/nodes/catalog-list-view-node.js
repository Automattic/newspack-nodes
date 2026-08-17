/**
 * CatalogListView — the slice view for a catalog whose reply IS a list, such as
 * `taillog sources` or `list_logs`. `useLogCatalog` is its only builder.
 *
 * A reply that is not a list leaves the previous catalog standing: an empty
 * picker is indistinguishable from "the answer did not parse", and a dashboard
 * whose subscription is chosen from this list has nothing to fall back on.
 */

import { sliceView } from './slice-view-node';

export const CatalogListViewNode = sliceView( {
	empty: { items: [], error: null },
	parse: ( body ) =>
		Array.isArray( body ) ? { items: body, error: null } : null,
} );

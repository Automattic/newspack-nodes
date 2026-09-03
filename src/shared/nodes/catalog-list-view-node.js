import { sliceView } from './slice-view-node';

/**
 * CatalogListViewNode — the slice view holding a picker's catalog: the rows a
 * dashboard chooses a log source or a stream subscription from. `useLogCatalog`
 * is its only builder.
 *
 * Its two verbs, `taillog sources` and `list_logs`, answer with a struct rather
 * than a JSON string, because the command interpreter puts a verb's return
 * value on the reply VALUE unencoded. The declaration therefore leaves `json`
 * off and reads the array straight off the payload. The rows publish under
 * `items`, which is the key `useLogCatalog` reads.
 *
 * A reply that is not an array parses to null, leaving the catalog already on
 * screen: an empty picker and "the answer did not parse" render identically,
 * and a dashboard whose subscription comes from this list has nothing to fall
 * back on.
 *
 * The shape declares `error` so a refused poll has somewhere to land and the
 * next good reply has something to clear. It declares no `loading`: the poll
 * runs every ten seconds and a refusal recovers on the following tick, so there
 * is no loader to show and no retry to schedule.
 */
export const CatalogListViewNode = sliceView( {
	empty: { items: [], error: null },
	parse: ( body ) =>
		Array.isArray( body ) ? { items: body, error: null } : null,
} );

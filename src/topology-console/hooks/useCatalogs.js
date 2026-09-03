/**
 * The console's catalogs — the palette's substrate classes, the OPEN dialog's
 * saved topologies and the vault_id dropdown's vaults — plus the on-demand
 * reader for one topology's body.
 *
 * Each catalog is the same slice on the batched poll: one `list` verb per tick,
 * published as state. The tick IS the retry, so a session that turns over
 * recovers on its own and a save owes the OPEN dialog no reload; a bad tick
 * keeps whatever is already on screen, since an empty palette is the worse
 * answer. Batched, a catalog costs no request of its own. A one-shot load
 * behind a latch or a memoised promise is the shape this rejects: its first
 * failure empties the list for the life of the page, and nothing asks again.
 *
 * `loading` goes false the moment a failure is in hand, because the poll keeps
 * asking behind it — a broken catalog shows its error rather than a spinner
 * nothing stops. Each catalog also carries the slice's `refresh()`, for a
 * caller that has just CHANGED the list and should not wait out the cadence.
 *
 * `useTopology` is the exception and stays one: one topology's BODY, asked for
 * by name on demand rather than polled.
 */

import { useCallback } from '@wordpress/element';
import { useCatalogSlice } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';
import { views } from '../nodes/register';
// The vault dropdown reads the Vault screen's own slice, so it shares its view.
import { views as vaultViews } from '../../vault/nodes/register';

/**
 * The palette's catalog: every Node class this site can build, and the
 * formatter names an argument may pick from.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False, the default, costs no request at all.
 * @return {{classes: Object[], formatters: string[], loading: boolean, error: ?string, refresh: () => void}}
 *   `classes` are the `classes list` entries — one per Node class the palette
 *   may offer, the serializable half of its `node_schema()` inlined, sorted by
 *   category then shell name; `formatters` are the registry's names. Both stay
 *   empty until the first reply lands, which is what `loading` reads.
 */
export function useClassCatalog( { enabled = false } = {} ) {
	const model = useCatalogSlice( {
		scope: 'classes',
		ci: 'classes',
		viewClass: views.ClassCatalogView,
		key: 'classes',
		enabled,
	} );

	return {
		...model,
		classes: model.classes ?? [],
		formatters: model.formatters ?? [],
	};
}

/**
 * The OPEN dialog's catalog of saved topologies, and the directory a save
 * writes into.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False, the default, costs no request at all —
 *                              the dialog polls only while it is open.
 * @return {{topologies: Object[], userDir: string, loading: boolean, error: ?string, refresh: () => void}}
 *   `topologies` are the `topologies list` entries (`name`, `source`, `active`,
 *   `num_partitions`, `frontmatter`, `includes`), sorted by name; `userDir` is
 *   the writable topology directory, empty when none is configured.
 */
export function useTopologyList( { enabled = false } = {} ) {
	const model = useCatalogSlice( {
		scope: 'topologies:list',
		ci: 'topologies',
		viewClass: views.TopologyListView,
		key: 'topologies',
		enabled,
	} );

	return {
		...model,
		topologies: model.topologies ?? [],
		userDir: model.userDir ?? '',
	};
}

/**
 * The vault_id dropdown's servers, in option shape.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False, the default, costs no request at all.
 * @return {{vaults: Array<{id: string, url: string}>, loading: boolean, error: ?string, refresh: () => void}}
 *   `vaults` keeps the id and the url of each record `vault list` answers with,
 *   dropping the username and the credential flags a dropdown cannot render.
 */
export function useVaults( { enabled = false } = {} ) {
	const model = useCatalogSlice( {
		scope: 'vault:list',
		ci: 'vault',
		viewClass: vaultViews.VaultListView,
		key: 'servers',
		enabled,
	} );

	return {
		...model,
		vaults: ( model.servers ?? [] ).map( ( v ) => ( {
			id: v.id,
			url: v.url ?? '',
		} ) ),
	};
}

/**
 * One topology's TSL body and the metadata the console opens it with, asked for
 * by name rather than polled.
 *
 * `open( name )` names what is wanted, the next tick asks for it, and the answer
 * arrives as published state. A promise-returning `fetch( name )` cannot: minted
 * from a React callback, it is a POST of its own, outside the router's
 * lock/flush bracket and batched with nothing.
 *
 * Being a read, it retries — an unanswered ask is what leaves an editor open on
 * half a page. Being answered is what stops it, refusal included, so a topology
 * that does not exist costs one command rather than one every five seconds.
 *
 * @param {Object}  o           Options.
 * @param {string}  o.scope     Names this reader's own slice. Two readers
 *                              wanting two different topologies are two slices,
 *                              never one node demultiplexing — see ADR-7.
 * @param {boolean} [o.enabled] Defaults to true; false makes `open()` a no-op.
 * @return {{open: (name: string) => void, topology: ?Object, loading: boolean, error: ?string}}
 *   `open()` requests a topology by name; `topology` is the answer to the most
 *   recent one — `{name, source, tsl, includes, expanded,
 *   resolved_config_edges}` — or null while an ask is outstanding.
 */
export function useTopology( { scope, enabled = true } ) {
	const { run, result, error, pending } = useCommandOnce( {
		ci: 'topologies',
		command: 'get',
		scope: `topologies:get:${ scope }`,
		retry: true,
	} );

	const open = useCallback(
		( name ) => {
			if ( enabled && name ) {
				run( formatCommandArgs( [ name ] ) );
			}
		},
		[ enabled, run ]
	);

	return {
		open,
		// While a newer ask is outstanding the previous answer is not "mine".
		topology: pending ? null : result,
		loading: pending,
		error,
	};
}

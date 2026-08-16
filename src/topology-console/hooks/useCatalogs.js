/**
 * The console's catalogs: the palette's substrate classes, the OPEN dialog's
 * saved topologies, and the vault_id dropdown's vaults.
 *
 * Each was its own one-shot load behind a latch or a memoised promise, so one
 * failure emptied its list for the life of the page — the overnight tab loaded
 * fine at mount, the session expired an hour later, and nothing ever asked
 * again. Each is now the SAME slice on the batched poll: one `list` verb per
 * tick, published as state. The tick is the retry, so a turned-over session
 * recovers on its own and a save owes the OPEN dialog no reload; a bad tick
 * keeps whatever is already on screen, since an empty palette is the worse
 * answer. Batched, a catalog costs no request of its own.
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
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] Gate — see `useCatalogSlice`.
 * @return {{classes: Object[], formatters: string[], loading: boolean, error: ?string}}
 *   `classes` are the palette entries from `classes list` (one per concrete
 *   Node class, schema inlined), `formatters` their registered formatter names.
 *   Consumers READ these; there is nothing to call.
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
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] Gate — see `useCatalogSlice`.
 * @return {{topologies: Object[], userDir: string, loading: boolean, error: ?string}}
 *   `topologies` are the catalog entries (`name`, `source`, `active`,
 *   `num_partitions`, `frontmatter`); `userDir` is the writable topology
 *   directory, empty when none is configured.
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
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] Gate — see `useCatalogSlice`.
 * @return {{vaults: Array<{id: string, url: string}>, loading: boolean, error: ?string}}
 *   The catalog in option shape. `loading` is false once a failure is in hand,
 *   since the poll keeps retrying behind it.
 */
export function useVaults( { enabled = false } = {} ) {
	// The same slice the Vault screen reads; the dropdown wants option shape.
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
 * useTopology — one topology's TSL body, on demand.
 *
 * The awaited `fetchTopology( name )` it used to return was a POST of its own,
 * minted from a React callback and therefore outside the router's lock/flush
 * bracket. It is a one-shot READ now: `open( name )` names what is wanted, the
 * tick asks for it, and the answer arrives as published state.
 *
 * Being a read, it retries — an unanswered ask is what leaves an editor open on
 * half a page. Being answered is what stops it, refusal included, so a topology
 * that does not exist costs one command rather than one per second.
 *
 * @param {Object}  o           Options.
 * @param {string}  o.scope     Names this reader's own slice. Two readers
 *                              wanting two different topologies are two slices,
 *                              never one node demultiplexing — see ADR-7.
 * @param {boolean} [o.enabled] False ignores `open()` entirely.
 * @return {{open: (name: string) => void, topology: ?Object, loading: boolean, error: ?string}}
 *   `open()` requests a topology by name; `topology` is the answer to the most
 *   recent `open()` and null until it lands, so a caller reads it as "mine".
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

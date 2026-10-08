/**
 * The console's catalogs — the palette's substrate classes, the OPEN dialog's
 * saved topologies and the vault pickers' entries — plus the on-demand
 * reader for one topology's body.
 *
 * Each catalog is the same slice on the batched poll: one catalog verb per tick,
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
 *
 * Every command a console control sends belongs to the group named for the
 * server CI it reaches, so each CI's traffic passes a Tap of its own —
 * `topologies:shell`, `layouts:shell`, `classes:shell` and `vault:shell` — and
 * `connect <ci>:shell` watches that family. The fleet board and the Vault
 * screen send under the `topologies` and `vault` groups too, so a page mounting
 * one of them beside the console shares that Tap. The four constants below are
 * the one spelling of each, used as both the group and the CI mount. Typed
 * REPL lines pass `_shell` instead.
 */

import { useCallback } from '@wordpress/element';
import { useCatalogSlice } from '@newspack-nodes/shared/hooks/useBatchedPoll';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';
import { views } from '../nodes/register';
// The vault dropdown reads the Vault screen's own slice, so it shares its view.
import { views as vaultViews } from '../../vault/nodes/register';

/** Topology reads and writes, the Path menu's catalog and the OPEN dialog. */
export const TOPOLOGIES_CI = 'topologies';

/** Each topology's saved canvas positions. */
export const LAYOUTS_CI = 'layouts';

/** The palette's catalog of Node classes. */
const CLASSES_CI = 'classes';

/** The vault_id and vault_group pickers' servers. */
const VAULT_CI = 'vault';

/**
 * The palette's catalog: every Node class this site can build, and the
 * formatter names an argument may pick from.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False, the default, costs no request at all.
 * @return {{classes: Object[], formatters: string[], loading: boolean, error: ?string, refresh: () => void}}
 *   `classes` are the `classes dump` entries — one per Node class the palette
 *   may offer, the serializable half of its `node_schema()` inlined, sorted by
 *   category then shell name; `formatters` are the registry's names. Both stay
 *   empty until the first reply lands, which is what `loading` reads.
 */
export function useClassCatalog( { enabled = false } = {} ) {
	const model = useCatalogSlice( {
		group: CLASSES_CI,
		scope: 'classes',
		ci: CLASSES_CI,
		command: 'dump',
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
 *   `topologies` are the `topologies dump` entries (`name`, `source`, `active`,
 *   `num_partitions`, `frontmatter`, `includes`), sorted by name; `userDir` is
 *   the writable topology directory, empty when none is configured.
 */
export function useTopologyList( { enabled = false } = {} ) {
	const model = useCatalogSlice( {
		group: TOPOLOGIES_CI,
		scope: 'topologies',
		ci: TOPOLOGIES_CI,
		command: 'dump',
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
 * The vault_id and vault_group pickers' servers, in option shape.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False, the default, costs no request at all.
 * @return {{vaults: Array<{id: string, url: string, group: string}>, loading: boolean, error: ?string, refresh: () => void}}
 *   `vaults` keeps the id, url and group of each record `vault list` answers with,
 *   dropping the username and the credential flags a dropdown cannot render.
 */
export function useVaults( { enabled = false } = {} ) {
	const model = useCatalogSlice( {
		group: VAULT_CI,
		scope: 'vault',
		ci: VAULT_CI,
		viewClass: vaultViews.VaultListView,
		key: 'servers',
		enabled,
	} );

	return {
		...model,
		vaults: ( model.servers ?? [] ).map( ( v ) => ( {
			id: v.id,
			url: v.url ?? '',
			group: v.group ?? '',
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
 * @param {Object}  o                 Options.
 * @param {string}  o.scope           Names this reader's own slice, `<scope>-topology`.
 *                                    Two readers wanting two different topologies are
 *                                    two slices, never one node demultiplexing — see
 *                                    ADR-7.
 * @param {boolean} [o.enabled]       Defaults to true; false makes `open()` a no-op.
 * @param {boolean} [o.groupChildren] False asks for the expansion with each
 *                                    Vault_Group as written, none of its members.
 * @return {{open: (name: string) => void, topology: ?Object, loading: boolean, error: ?string}}
 *   `open()` requests a topology by name; `topology` is the answer to the most
 *   recent one — `{name, source, tsl, includes, expanded,
 *   resolved_config_edges, owned}` — or null while an ask is outstanding.
 */
export function useTopology( { scope, enabled = true, groupChildren = true } ) {
	const { run, result, error, pending } = useCommandOnce( {
		group: TOPOLOGIES_CI,
		ci: TOPOLOGIES_CI,
		command: 'get',
		scope: `${ scope }-topology`,
		retry: true,
	} );

	const open = useCallback(
		( name ) => {
			if ( enabled && name ) {
				run(
					formatCommandArgs(
						[ name ],
						groupChildren ? {} : { group_children: false }
					)
				);
			}
		},
		[ enabled, groupChildren, run ]
	);

	return {
		open,
		// While a newer ask is outstanding the previous answer is not "mine".
		topology: pending ? null : result,
		loading: pending,
		error,
	};
}

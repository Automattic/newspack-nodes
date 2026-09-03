/**
 * CatalogContext — the catalogs the canvas, the palette and the inspector read.
 *
 * Nothing between the console root and those three surfaces touches a catalog,
 * so context carries all six rather than a prop chain: the canvas takes
 * `classCatalog`, the palette `classes` and `topologies`, the inspector
 * `classes`, `formatters`, `vaults` and `composeTargets`.
 *
 * Catalogs belong here where the mutation handlers do not, because a class
 * list is the same list whether you are editing a topology or watching a live
 * worker: a catalog has no edit-versus-live branch to resolve, and a handler
 * does. Both graph-surface mounts provide them — the topology console and the
 * debug overlay's inspector tab.
 */

import { createContext, useContext, useMemo } from '@wordpress/element';

/**
 * The context itself, private to this module. `null` is the no-provider
 * sentinel `useCatalog()` refuses on, never a value a provider supplies.
 */
const CatalogContext = createContext( null );

/**
 * The empty default every absent list catalog shares. Module-level, because a
 * fresh `[]` per render is a fresh identity: the memo below would then rebuild
 * its value every render and re-render every memoised consumer.
 */
const NO_ENTRIES = Object.freeze( [] );

/**
 * The empty default an absent `classCatalog` takes, module-level for the same
 * reason as `NO_ENTRIES`.
 */
const NO_SCHEMAS = Object.freeze( {} );

/**
 * Publishes the six catalogs to every graph surface mounted below.
 *
 * @param {Object}                    props                  Component props.
 * @param {Object}                    [props.classCatalog]   One class entry per shell name; the canvas reads its port flags.
 * @param {ReadonlyArray<Object>}     [props.classes]        Class list — the palette's tiles and the inspector's verb schemas.
 * @param {ReadonlyArray<string>}     [props.formatters]     Registered formatter names, offered in the argument editors.
 * @param {ReadonlyArray<Object>}     [props.vaults]         Vault catalog, behind the `vault_id` argument dropdown.
 * @param {ReadonlyArray<Object>}     [props.topologies]     `topologies list` entries, the palette's topology tiles.
 * @param {string[]}                  [props.composeTargets] The Compose modal's "To" list. A mount that supplies none leaves it undefined, so the inspector falls back to the ids of the graph on screen.
 * @param {import('react').ReactNode} props.children         Consumers.
 * @return {import('react').ReactElement} The provider.
 */
export function CatalogProvider( {
	classCatalog = NO_SCHEMAS,
	classes = NO_ENTRIES,
	formatters = NO_ENTRIES,
	vaults = NO_ENTRIES,
	topologies = NO_ENTRIES,
	// NOT defaulted: `composeTargets ?? parsed.nodes` needs undefined.
	composeTargets,
	children,
} ) {
	const value = useMemo(
		() => ( {
			classCatalog,
			classes,
			formatters,
			vaults,
			topologies,
			composeTargets,
		} ),
		[
			classCatalog,
			classes,
			formatters,
			vaults,
			topologies,
			composeTargets,
		]
	);
	return (
		<CatalogContext.Provider value={ value }>
			{ children }
		</CatalogContext.Provider>
	);
}

/**
 * Reads the catalogs from the nearest provider.
 *
 * Throwing beats serving empty catalogs: an empty `classes` leaves the palette
 * with nothing to drag and the inspector with no schema for the selected node,
 * which reads as a broken topology rather than a missing provider.
 *
 * @return {Object} `{ classCatalog, classes, formatters, vaults, topologies, composeTargets }`.
 */
export function useCatalog() {
	const value = useContext( CatalogContext );
	if ( ! value ) {
		throw new Error( 'useCatalog called outside a CatalogProvider' );
	}
	return value;
}

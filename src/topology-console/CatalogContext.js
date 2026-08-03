/**
 * CatalogContext — the server-side catalogs the graph surface reads.
 *
 * `classCatalog` (ports per shell name), `classes` (the palette + verb list),
 * `formatters`, `vaults`, `topologies` and `composeTargets` were threaded
 * TopologyConsole → ConsoleShell → GraphView → child. GraphView read none of
 * them; it forwarded all six.
 *
 * These lift cleanly where the mutation handlers do not, and the reason is
 * worth keeping: a class list is the same list whether you are editing a
 * topology or watching a live worker, so there is no edit-vs-live branch to
 * resolve. Both graph-surface mounts provide it — the console and the debug
 * overlay's inspector tab.
 */

import { createContext, useContext, useMemo } from '@wordpress/element';

const CatalogContext = createContext( null );

// Module-level: a fresh [] per render would defeat the memo below.
const NO_ENTRIES = Object.freeze( [] );
const NO_SCHEMAS = Object.freeze( {} );

/**
 * @param {Object} props                  Component props.
 * @param {Object} [props.classCatalog]   shell_name → schema (canvas ports).
 * @param {Array}  [props.classes]        Class list (palette + verb schemas).
 * @param {Array}  [props.formatters]     Formatter list (arg editors).
 * @param {Array}  [props.vaults]         Vault catalog (vault_id args).
 * @param {Array}  [props.topologies]     `topologies list` entries.
 * @param {Array}  [props.composeTargets] The Compose modal's "To" list; stays
 *                                        undefined when absent, by design.
 * @param {*}      props.children         Consumers.
 * @return {Element} The provider.
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
 * @return {Object} `{ classCatalog, classes, formatters, vaults, topologies, composeTargets }`.
 */
export function useCatalog() {
	const value = useContext( CatalogContext );
	if ( ! value ) {
		// Loud: empty catalogs read as a broken topology.
		throw new Error( 'useCatalog called outside a CatalogProvider' );
	}
	return value;
}

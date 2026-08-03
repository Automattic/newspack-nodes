/**
 * CatalogContext — the server-side catalogs the canvas, palette and inspector
 * all read. They were threaded TopologyConsole → ConsoleShell → GraphView →
 * child, four levels, with GraphView reading none of the six itself.
 *
 * Mode-independent on purpose: unlike the mutation handlers, a class list is
 * the same list whether you are editing a topology or watching a live worker.
 * That is what makes these safe to lift out of the prop chain.
 */

import { renderHook } from '@testing-library/react';
import { CatalogProvider, useCatalog } from '../CatalogContext';

describe( 'useCatalog', () => {
	it( 'carries every catalog its readers need', () => {
		const value = {
			classCatalog: { Tee: { ports: [ 'out' ] } },
			classes: [ { shell_name: 'Tee' } ],
			formatters: [ 'quokka_case' ],
			vaults: [ { id: 'wombat-vault' } ],
			topologies: [ { name: 'census-2026' } ],
			composeTargets: [ '_command_interpreter' ],
		};
		const wrapper = ( { children } ) => (
			<CatalogProvider { ...value }>{ children }</CatalogProvider>
		);

		const { result } = renderHook( () => useCatalog(), { wrapper } );

		expect( result.current ).toEqual( value );
	} );

	it( 'defaults every catalog to empty so a partial provider still renders', () => {
		// The debug overlay declares no topologies — it has no palette section
		// for them — so an absent catalog must read as empty, not undefined.
		const wrapper = ( { children } ) => (
			<CatalogProvider classes={ [ { shell_name: 'Tee' } ] }>
				{ children }
			</CatalogProvider>
		);

		const { result } = renderHook( () => useCatalog(), { wrapper } );

		expect( result.current.topologies ).toEqual( [] );
		expect( result.current.classCatalog ).toEqual( {} );
		// Inspector distinguishes "none supplied" from "supplied and empty":
		// `composeTargets ?? parsed.nodes` must still reach its fallback.
		expect( result.current.composeTargets ).toBeUndefined();
		expect( result.current.classes ).toEqual( [ { shell_name: 'Tee' } ] );
	} );

	it( 'throws outside a provider rather than serving empty catalogs', () => {
		// Loud: empty catalogs render as "this node type does not exist",
		// which reads as a broken topology rather than a missing provider.
		const quiet = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			expect( () => renderHook( () => useCatalog() ) ).toThrow(
				/CatalogProvider/
			);
		} finally {
			quiet.mockRestore();
		}
	} );
} );

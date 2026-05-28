import { renderHook } from '@testing-library/react';
import { useJsCatalog } from '../useJsCatalog';
import { CommandInterpreter } from '../../../runtime/command_interpreter';

describe( 'useJsCatalog', () => {
	it( 'returns classes from CommandInterpreter.includeNodes (the JS make_node table)', () => {
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		// Base table — Node, Tee, Timer, CommandInterpreter are registered.
		expect( names ).toEqual( expect.arrayContaining( [ 'Tee', 'Timer' ] ) );
	} );

	it( 'each entry has shell_name + category (the Palette grouping fields)', () => {
		const { result } = renderHook( () => useJsCatalog() );
		for ( const c of result.current.classes ) {
			expect( typeof c.shell_name ).toBe( 'string' );
			expect( typeof c.category ).toBe( 'string' );
		}
	} );

	it( 'excludes Hook and Router (not user-makeable in the overlay)', () => {
		// Stash + restore so the test is self-contained.
		const before = { ...CommandInterpreter.includeNodes };
		CommandInterpreter.includeNodes.Hook = function Hook() {};
		CommandInterpreter.includeNodes.Router = function Router() {};
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		expect( names ).not.toContain( 'Hook' );
		expect( names ).not.toContain( 'Router' );
		CommandInterpreter.includeNodes = before;
	} );
} );

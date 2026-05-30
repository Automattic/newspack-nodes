import { renderHook } from '@testing-library/react';
import { useJsCatalog } from '../useJsCatalog';
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';

describe( 'useJsCatalog', () => {
	it( 'returns classes from CommandInterpreterNode.includeNodes (the JS make_node table)', () => {
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

	it( 'excludes Hook, Router, and CommandInterpreter (not user-makeable in the overlay)', () => {
		// Stash + restore so the test is self-contained.
		const before = { ...CommandInterpreterNode.includeNodes };
		CommandInterpreterNode.includeNodes.Hook = function Hook() {};
		CommandInterpreterNode.includeNodes.Router = function Router() {};
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		expect( names ).not.toContain( 'Hook' );
		expect( names ).not.toContain( 'Router' );
		// CommandInterpreter is genuinely in includeNodes (the base table) but
		// is never dropped by hand — every graph already has _command_interpreter.
		expect( names ).not.toContain( 'CommandInterpreter' );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( "propagates accepts_fill / has_target from each node's nodeSchema()", () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// A source: declares accepts_fill:false (PHP Tail/Consumer pattern).
		CommandInterpreterNode.includeNodes.FakeSource = class {
			static nodeSchema() {
				return { accepts_fill: false, has_target: true };
			}
		};
		// A terminal: declares has_target:false (PHP Log/Topic pattern).
		CommandInterpreterNode.includeNodes.FakeSink = class {
			static nodeSchema() {
				return { accepts_fill: true, has_target: false };
			}
		};
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.FakeSource.accepts_fill ).toBe( false );
		expect( byName.FakeSource.has_target ).toBe( true );
		expect( byName.FakeSink.accepts_fill ).toBe( true );
		expect( byName.FakeSink.has_target ).toBe( false );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( 'defaults both port flags to true when the schema omits them (PHP base default + GUI ?? true)', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// No nodeSchema at all (like the base Node / Tee / SseIn).
		CommandInterpreterNode.includeNodes.FakeBare = class {};
		// nodeSchema present but no port flags declared.
		CommandInterpreterNode.includeNodes.FakePartial = class {
			static nodeSchema() {
				return { category: 'Control' };
			}
		};
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.FakeBare.accepts_fill ).toBe( true );
		expect( byName.FakeBare.has_target ).toBe( true );
		expect( byName.FakePartial.accepts_fill ).toBe( true );
		expect( byName.FakePartial.has_target ).toBe( true );
		CommandInterpreterNode.includeNodes = before;
	} );
} );

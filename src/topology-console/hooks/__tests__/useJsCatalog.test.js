import { renderHook } from '@testing-library/react';
import { useJsCatalog } from '../useJsCatalog';
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';

describe( 'useJsCatalog', () => {
	it( 'returns real-category classes from CommandInterpreterNode.includeNodes (the JS make_node table)', () => {
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		// Timer declares category 'Control' in its nodeSchema, so it's a palette
		// participant. (Schema-less base nodes inherit the empty-category default
		// and are filtered out — matching PHP Classes_CI's '' === cat skip.)
		expect( names ).toContain( 'Timer' );
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

	it( 'propagates arguments[] from nodeSchema so the ADD modal renders ctor fields (PHP parity)', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// A node that declares a ctor arg — the browser ADD modal must render it,
		// matching the PHP catalog (classes-ci-node inlines schema.arguments).
		CommandInterpreterNode.includeNodes.FakeArged = class {
			static nodeSchema() {
				return {
					category: 'Control',
					arguments: [
						{ name: 'interval_ms', type: 'int', required: false },
					],
				};
			}
		};
		// A node with no declared arguments defaults to [] (not undefined).
		CommandInterpreterNode.includeNodes.FakeNoArgs = class {
			static nodeSchema() {
				return { category: 'Control' };
			}
		};
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.FakeArged.arguments ).toEqual( [
			{ name: 'interval_ms', type: 'int', required: false },
		] );
		expect( byName.FakeNoArgs.arguments ).toEqual( [] );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( "propagates accepts_fill / has_target from each node's nodeSchema()", () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// A source: declares accepts_fill:false (PHP Tail/Consumer pattern).
		// Needs a real category to survive the Hidden/empty filter.
		CommandInterpreterNode.includeNodes.FakeSource = class {
			static nodeSchema() {
				return {
					category: 'IO',
					accepts_fill: false,
					has_target: true,
				};
			}
		};
		// A terminal: declares has_target:false (PHP Log/Topic pattern).
		CommandInterpreterNode.includeNodes.FakeSink = class {
			static nodeSchema() {
				return {
					category: 'Storage',
					accepts_fill: true,
					has_target: false,
				};
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

	it( "excludes Hidden-category classes (PHP skips 'Hidden' === cat) and includes a real-category one", () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// A Hidden node (DumperNode/CompletionNode pattern) must NOT leak into the palette.
		CommandInterpreterNode.includeNodes.FakeHidden = class {
			static nodeSchema() {
				return { category: 'Hidden' };
			}
		};
		// A real-category node IS included, carrying its real category.
		CommandInterpreterNode.includeNodes.FakeVisible = class {
			static nodeSchema() {
				return { category: 'Routing', description: 'fan-out' };
			}
		};
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.FakeHidden ).toBeUndefined();
		expect( byName.FakeVisible.category ).toBe( 'Routing' );
		expect( byName.FakeVisible.description ).toBe( 'fan-out' );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( "excludes empty-category and missing-schema classes (PHP skips '' === cat)", () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// Explicit empty category — PHP `?? ''` then `'' === $cat` skips it.
		CommandInterpreterNode.includeNodes.FakeEmptyCat = class {
			static nodeSchema() {
				return { category: '' };
			}
		};
		// nodeSchema present but no category — defaults to '' and is skipped.
		CommandInterpreterNode.includeNodes.FakeNoCat = class {
			static nodeSchema() {
				return { description: 'no category here' };
			}
		};
		// No nodeSchema at all — category is null/absent, skipped.
		CommandInterpreterNode.includeNodes.FakeNoSchema = class {};
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		expect( names ).not.toContain( 'FakeEmptyCat' );
		expect( names ).not.toContain( 'FakeNoCat' );
		expect( names ).not.toContain( 'FakeNoSchema' );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( 'sorts entries by [category, shell_name] to match PHP usort', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		CommandInterpreterNode.includeNodes.Zebra = class {
			static nodeSchema() {
				return { category: 'Alpha' };
			}
		};
		CommandInterpreterNode.includeNodes.Apple = class {
			static nodeSchema() {
				return { category: 'Alpha' };
			}
		};
		CommandInterpreterNode.includeNodes.Mango = class {
			static nodeSchema() {
				return { category: 'Beta' };
			}
		};
		const { result } = renderHook( () => useJsCatalog() );
		const ordered = result.current.classes.map( ( c ) => [
			c.category,
			c.shell_name,
		] );
		const apple = ordered.findIndex( ( [ , n ] ) => 'Apple' === n );
		const zebra = ordered.findIndex( ( [ , n ] ) => 'Zebra' === n );
		const mango = ordered.findIndex( ( [ , n ] ) => 'Mango' === n );
		// Same category: Apple before Zebra (shell_name order).
		expect( apple ).toBeLessThan( zebra );
		// 'Alpha' category sorts before 'Beta' category.
		expect( zebra ).toBeLessThan( mango );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( 'defaults both port flags to true when the schema omits them (PHP base default + GUI ?? true)', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// nodeSchema with a real category but no port flags declared — flags
		// must default to true. (A schema-less class is excluded entirely; the
		// empty-category test covers that path.)
		CommandInterpreterNode.includeNodes.FakeBare = class {
			static nodeSchema() {
				return { category: 'Control' };
			}
		};
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

import { renderHook } from '@testing-library/react';
import { useJsCatalog } from '../useJsCatalog';
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';

describe( 'useJsCatalog', () => {
	it( 'returns real-category classes from CommandInterpreterNode.includeNodes (the JS make_node table)', () => {
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		// Timer's 'Control' category = palette entry; empty cat = skipped.
		expect( names ).toContain( 'Timer' );
	} );

	it( 'surfaces HttpOut and SseIn in the I/O category (draggable from the palette)', () => {
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.HttpOut ).toBeDefined();
		expect( byName.HttpOut.category ).toBe( 'I/O' );
		expect( byName.SseIn ).toBeDefined();
		expect( byName.SseIn.category ).toBe( 'I/O' );
	} );

	it( 'surfaces both configured Remote channels in the I/O palette', () => {
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);

		expect( byName.RemoteLink.category ).toBe( 'I/O' );
		expect( byName.RemoteLink.arguments ).toEqual( [
			{ name: 'subscribe', type: 'string', required: true },
		] );
		expect( byName.RemoteIpc.category ).toBe( 'I/O' );
		expect( byName.RemoteIpc.arguments ).toEqual( [
			{
				name: 'reader',
				type: 'string',
				required: true,
				description: 'Remote worker reader, e.g. combined.p7.',
			},
		] );
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
		// CommandInterpreter is in includeNodes but every graph already has it.
		expect( names ).not.toContain( 'CommandInterpreter' );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( 'propagates arguments[] from nodeSchema so the ADD modal renders ctor fields (PHP parity)', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// Node declares a ctor arg — ADD modal must render it (PHP parity).
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
		// Source: accepts_fill:false (PHP Tail/Consumer); category required.
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
		// A Hidden node (DumperNode pattern) must NOT leak into the palette.
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

	/**
	 * `draft-interpreter-node`'s `_catalogFansOut` reads `entry.fans_out` and
	 * only falls back to the `'Tee'` name when there is NO entry — a
	 * present-but-flagless entry reads `undefined` as false and wires a
	 * fan-out node single-target, dropping every edge past the first.
	 */
	it( 'derives fans_out from the class, so Tee and its subclasses carry it', () => {
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.Tee.fans_out ).toBe( true );
		expect( byName.Tap.fans_out ).toBe( true );
		expect( byName.Timer.fans_out ).toBe( false );
	} );

	it( 'derives is_interpreter from the class (bare target vs <name>:config)', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		class FakeCI extends CommandInterpreterNode {
			static nodeSchema() {
				return { category: 'Control' };
			}
		}
		CommandInterpreterNode.includeNodes.FakeCI = FakeCI;
		const { result } = renderHook( () => useJsCatalog() );
		const byName = Object.fromEntries(
			result.current.classes.map( ( c ) => [ c.shell_name, c ] )
		);
		expect( byName.FakeCI.is_interpreter ).toBe( true );
		expect( byName.Timer.is_interpreter ).toBe( false );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( 'skips a schema carrying the hidden flag (PHP skips ! empty( hidden ))', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		CommandInterpreterNode.includeNodes.FakeFlagged = class {
			static nodeSchema() {
				return { category: 'Routing', hidden: true };
			}
		};
		const { result } = renderHook( () => useJsCatalog() );
		const names = result.current.classes.map( ( c ) => c.shell_name );
		expect( names ).not.toContain( 'FakeFlagged' );
		CommandInterpreterNode.includeNodes = before;
	} );

	it( 'defaults both port flags to true when the schema omits them (PHP base default + GUI ?? true)', () => {
		const before = { ...CommandInterpreterNode.includeNodes };
		// Real category, no port flags declared → both flags default to true.
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

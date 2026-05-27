import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';
import { useDebugGraph } from '../useDebugGraph';

describe( 'useDebugGraph', () => {
	beforeEach( () => {
		Core.reset();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'reads the live Core graph and re-reads on the tick', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result } = renderHook( () => useDebugGraph() );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'a'
		);
		const b = new Node();
		b.setName( 'b' );
		act( () => jest.advanceTimersByTime( 1000 ) );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'b'
		);
		teardown();
	} );

	it( 'does not poll when inactive', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result } = renderHook( () => useDebugGraph( false ) );
		const b = new Node();
		b.setName( 'b' );
		act( () => jest.advanceTimersByTime( 5000 ) );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).not.toContain(
			'b'
		);
		teardown();
	} );

	it( 'refreshes immediately when activated', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result, rerender } = renderHook(
			( { active } ) => useDebugGraph( active ),
			{ initialProps: { active: false } }
		);
		const b = new Node();
		b.setName( 'b' );
		// Still inactive: b not seen.
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).not.toContain(
			'b'
		);
		// Flip to active: immediate refresh, no timer advance.
		act( () => rerender( { active: true } ) );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'b'
		);
		teardown();
	} );

	it( 'onConnect dispatches connect_node into the local CI', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const b = new Node();
		b.setName( 'b' );
		const { result } = renderHook( () => useDebugGraph() );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		// connect_node sets the base node's `target` string (command_interpreter
		// _cmdConnect → src.target = target). Assert the real effect.
		expect( Core.node( 'a' ).target ).toBe( 'b' );
		teardown();
	} );

	it( 'onInspectorAction handles tail / disconnect / trace (parity with the console)', () => {
		// The console's handleInspectorAction routes five non-invoke actions:
		// dump → dump_node, tail → connect_node <id> (no target = tail), disconnect
		// → disconnect_node, send → send_node, trace → debug_state. The overlay
		// previously handled only dump + invoke, silently dropping the rest.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result } = renderHook( () => useDebugGraph() );
		// tail = `connect_node a` with NO target — connect_node defaults to the
		// issuing message's FROM, which the overlay stamps as '_output' (the
		// transcript Dumper). So a.target becomes '_output' and a's emissions
		// flow into the transcript, which is the whole point of Tail.
		act( () =>
			result.current.handlers.onInspectorAction( 'tail', 'a', null )
		);
		expect( Core.node( 'a' ).target ).toBe( '_output' );
		// Set a.target so disconnect has something to clear.
		Core.node( 'a' ).target = 'somewhere';
		act( () =>
			result.current.handlers.onInspectorAction( 'disconnect', 'a', null )
		);
		// disconnect_node clears target (a string '').
		expect( Core.node( 'a' ).target ).toBe( '' );
		// trace sets debug_state; payload is the target level (0 or 1).
		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', 1 )
		);
		expect( Core.node( 'a' ).debugState ).toBe( 1 );
		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', 0 )
		);
		expect( Core.node( 'a' ).debugState ).toBe( 0 );
		teardown();
	} );

	it( 'onDropNode accepts the SchematicCanvas {shellName,x,y} envelope and dispatches make_node', () => {
		// SchematicCanvas.handleDrop calls onDropNode({shellName, x, y}) — a
		// single OBJECT, not (shellName, pos). The console's handleDropNode
		// destructures it. The overlay must too; the previous positional
		// implementation got `[object Object]` as the shellName.
		const { teardown } = mountExospine();
		const { result } = renderHook( () => useDebugGraph() );
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				x: 0,
				y: 0,
			} )
		);
		// Make_node creates a node whose id starts with 'tee' (generateNodeName
		// lowercases the shell name). The earlier `[object Object]` would have
		// produced a parse error and no node at all.
		const live = [ ...Core.nodes.keys() ];
		expect( live.some( ( n ) => n.startsWith( 'tee' ) ) ).toBe( true );
		teardown();
	} );
} );

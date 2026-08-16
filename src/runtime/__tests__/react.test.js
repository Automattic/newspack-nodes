import { renderHook, act } from '@testing-library/react';
import {
	useNodeState,
	useNodeEvent,
	useNodeFill,
	useGraphGeneration,
} from '../react';
import { Node } from '../node';
import { Core } from '../core';
import { newMessage, VALUE } from '../message';

beforeEach( () => Core.reset() );

test( 'useNodeState returns the cached value', () => {
	const n = new Node();
	n.name = 'svc';
	n.registrations.data = {};
	n.setState( 'data', 42 );

	const { result } = renderHook( () => useNodeState( 'svc', 'data' ) );
	expect( result.current ).toBe( 42 );
} );

test( 'useNodeState updates when setState fires', () => {
	const n = new Node();
	n.name = 'svc';
	n.registrations.data = {};

	const { result } = renderHook( () => useNodeState( 'svc', 'data' ) );
	expect( result.current ).toBeUndefined();
	act( () => {
		n.setState( 'data', 'hello' );
	} );
	expect( result.current ).toBe( 'hello' );
} );

test( 'useNodeState auto-pre-declares the event on a node that did not declare it', () => {
	const n = new Node();
	n.name = 'svc';
	// Don't pre-declare the event; the hook must auto-declare.
	const { result } = renderHook( () => useNodeState( 'svc', 'autoevt' ) );
	expect( result.current ).toBeUndefined();
	act( () => {
		n.setState( 'autoevt', 'auto' );
	} );
	expect( result.current ).toBe( 'auto' );
} );

test( 'useNodeState re-subscribes when the node under the name is replaced', () => {
	// The hook must follow a node swap under a stable name.
	const first = new Node();
	first.name = 'session';
	first.registrations.data = {};
	first.setState( 'data', 'from-first' );

	const { result, rerender } = renderHook( () =>
		useNodeState( 'session', 'data' )
	);
	expect( result.current ).toBe( 'from-first' );

	act( () => {
		Core.unregisterNode( 'session' );
		const second = new Node();
		second.name = 'session';
		second.registrations.data = {};
		// Re-render so the hook's effect re-runs against the new instance.
		rerender();
		// A later setState on the new node must reach the hook.
		second.setState( 'data', 'from-second' );
	} );
	expect( result.current ).toBe( 'from-second' );
} );

test( 'useNodeState resets to undefined when the replacement node has no cached value', () => {
	const first = new Node();
	first.name = 'session';
	first.registrations.data = {};
	first.setState( 'data', 'stale' );

	const { result, rerender } = renderHook( () =>
		useNodeState( 'session', 'data' )
	);
	expect( result.current ).toBe( 'stale' );

	act( () => {
		Core.unregisterNode( 'session' );
		const second = new Node();
		second.name = 'session';
		second.registrations.data = {};
		rerender();
	} );
	// The fresh node has no cached value; don't show the old one.
	expect( result.current ).toBeUndefined();
} );

test( 'useNodeFill returns a fill function for the named node', () => {
	const n = new Node();
	n.name = 'svc';
	const got = [];
	n.fill = ( m ) => got.push( m[ VALUE ] );

	const { result } = renderHook( () => useNodeFill( 'svc' ) );
	const m = newMessage();
	m[ VALUE ] = 'sent';
	act( () => result.current( m ) );
	expect( got ).toEqual( [ 'sent' ] );
} );

test( 'useGraphGeneration returns the current generation and re-renders on bump', () => {
	const { result } = renderHook( () => useGraphGeneration() );
	expect( result.current ).toBe( 0 );
	act( () => Core.bumpGraphGeneration() );
	expect( result.current ).toBe( 1 );
	act( () => Core.bumpGraphGeneration() );
	expect( result.current ).toBe( 2 );
} );

// @longform Delivery PER NOTIFY, not per render: two notifications inside one
// React batch are one re-render carrying only the later, so anything that ACTS
// on each publication has to register rather than read rendered state.
describe( 'useNodeEvent', () => {
	it( 'runs its callback once per notify, not once per render', () => {
		const n = new Node();
		n.name = 'svc';
		n.registrations.data = {};

		const seen = [];
		renderHook( () =>
			useNodeEvent( 'svc', 'data', ( v ) => seen.push( v ) )
		);
		act( () => {
			n.setState( 'data', 'first' );
			n.setState( 'data', 'second' );
		} );
		expect( seen ).toEqual( [ 'first', 'second' ] );
	} );

	// @longform `removeNode()` WIPES `registrations`, so a torn-down node has
	// no declared events and `register()` throws on it. Switching devtools
	// tabs tears one graph down while the next mounts, and a subscriber that
	// still holds the old node crashes the incoming tab. `useNodeState` never
	// hit this because it re-seeds the event first; so does this.
	it( 'subscribes to a node whose registrations teardown wiped', () => {
		const n = new Node();
		n.name = 'svc';
		// The state `removeNode()` leaves: the allow-list is emptied, so
		// `register()` throws on every event the class declared.
		n.registrations = {};

		const seen = [];
		expect( () =>
			renderHook( () =>
				useNodeEvent( 'svc', 'data', ( v ) => seen.push( v ) )
			)
		).not.toThrow();
		act( () => n.setState( 'data', 'landed' ) );
		expect( seen ).toEqual( [ 'landed' ] );
	} );

	it( 'is a no-op for a node that does not exist', () => {
		const seen = [];
		expect( () =>
			renderHook( () =>
				useNodeEvent( 'nope', 'data', ( v ) => seen.push( v ) )
			)
		).not.toThrow();
		expect( seen ).toEqual( [] );
	} );
} );

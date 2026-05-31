import { renderHook, act } from '@testing-library/react';
import { useNodeState, useNodeFill, useGraphGeneration } from '../react';
import { Node } from '../node';
import { Core } from '../core';
import { newMessage, VALUE } from '../message';

beforeEach( () => Core.reset() );

test( 'useNodeState returns the cached value', () => {
	const n = new Node();
	n.setName( 'svc' );
	n.registrations.data = {};
	n.setState( 'data', 42 );

	const { result } = renderHook( () => useNodeState( 'svc', 'data' ) );
	expect( result.current ).toBe( 42 );
} );

test( 'useNodeState updates when setState fires', () => {
	const n = new Node();
	n.setName( 'svc' );
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
	n.setName( 'svc' );
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
	first.setName( 'session' );
	first.registrations.data = {};
	first.setState( 'data', 'from-first' );

	const { result, rerender } = renderHook( () =>
		useNodeState( 'session', 'data' )
	);
	expect( result.current ).toBe( 'from-first' );

	act( () => {
		Core.unregisterNode( 'session' );
		const second = new Node();
		second.setName( 'session' );
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
	first.setName( 'session' );
	first.registrations.data = {};
	first.setState( 'data', 'stale' );

	const { result, rerender } = renderHook( () =>
		useNodeState( 'session', 'data' )
	);
	expect( result.current ).toBe( 'stale' );

	act( () => {
		Core.unregisterNode( 'session' );
		const second = new Node();
		second.setName( 'session' );
		second.registrations.data = {};
		rerender();
	} );
	// The fresh node has no cached value; don't show the old one.
	expect( result.current ).toBeUndefined();
} );

test( 'useNodeFill returns a fill function for the named node', () => {
	const n = new Node();
	n.setName( 'svc' );
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

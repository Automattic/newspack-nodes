import { renderHook, act } from '@testing-library/react';
import { useNodeState, useNodeFill } from '../react';
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
	// NOTE: deliberately NOT pre-declaring the event. The hook's
	// useEffect should auto-declare so register() doesn't throw.
	const { result } = renderHook( () => useNodeState( 'svc', 'autoevt' ) );
	expect( result.current ).toBeUndefined();
	act( () => {
		n.setState( 'autoevt', 'auto' );
	} );
	expect( result.current ).toBe( 'auto' );
} );

test( 'useNodeState re-subscribes when the node under the name is replaced', () => {
	// A session-style graph swaps the node registered under a stable name
	// (e.g. on worker change). The hook must follow the swap: re-subscribe
	// to the NEW node and reflect ITS state, not the stale old node's.
	const first = new Node();
	first.setName( 'session' );
	first.registrations.data = {};
	first.setState( 'data', 'from-first' );

	const { result, rerender } = renderHook( () =>
		useNodeState( 'session', 'data' )
	);
	expect( result.current ).toBe( 'from-first' );

	// Swap: drop the first node, register a fresh one under the same name.
	act( () => {
		Core.unregisterNode( 'session' );
		const second = new Node();
		second.setName( 'session' );
		second.registrations.data = {};
		// Re-render so the hook's effect re-runs against the new instance.
		rerender();
		// A later setState on the NEW node must reach the hook.
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
	// The fresh node has no cached `data` yet — the hook must not keep
	// showing the previous node's value.
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

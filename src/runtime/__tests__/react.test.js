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

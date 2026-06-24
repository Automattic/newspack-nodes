import { TapNode } from '../tap-node';
import { Node } from '../node';
import { Core } from '../core';
import { TO, VALUE, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'fill keeps a path-shaped target whose HEAD node is registered', () => {
	const head = new Node();
	head.name = 'alive';
	const router = new Node();
	router.name = '_router';
	router.fill = () => {};

	const t = new TapNode();
	t.sink = router;
	t.target = [ 'alive/workers' ];
	t.fill( newMessage() );

	expect( t.target ).toEqual( [ 'alive/workers' ] );
} );

test( 'fill prunes a path-shaped target whose HEAD node is dead', () => {
	const router = new Node();
	router.name = '_router';
	router.fill = () => {};

	const t = new TapNode();
	t.sink = router;
	t.target = [ 'gone/workers' ];
	t.fill( newMessage() );

	expect( t.target ).toEqual( [] );
} );

test( 'fill passes the original message through to the sink', () => {
	const seen = [];
	const sink = new Node();
	sink.fill = ( m ) => seen.push( [ ...m ] );

	const t = new TapNode();
	t.sink = sink;
	const m = newMessage();
	m[ VALUE ] = 'data';
	m[ TO ] = 'caller';
	t.fill( m );

	expect( seen ).toHaveLength( 1 );
	expect( seen[ 0 ][ VALUE ] ).toBe( 'data' );
	expect( seen[ 0 ][ TO ] ).toBe( 'caller' );
} );

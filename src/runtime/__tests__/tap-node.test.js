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

test( 'fill throws when an alive target has no wired sink', () => {
	const head = new Node();
	head.name = 'alive';

	const t = new TapNode();
	t.target = [ 'alive/workers' ];

	expect( () => t.fill( newMessage() ) ).toThrow(
		'fill requires a wired sink'
	);
} );

test( 'fill suppresses a target that throws and still passes the original through', () => {
	const head = new Node();
	head.name = 'alive';

	const seen = [];
	const sink = new Node();
	sink.fill = ( m ) => {
		if ( 'alive/workers' === m[ TO ] ) {
			throw new Error( 'boom' );
		}
		seen.push( [ ...m ] );
	};

	const t = new TapNode();
	t.sink = sink;
	t.target = [ 'alive/workers' ];
	const warnings = [];
	t.printLessOften = ( msg ) => warnings.push( msg );

	const m = newMessage();
	m[ TO ] = 'caller';
	t.fill( m );

	expect( warnings ).toEqual( [
		'WARNING: target alive/workers threw: boom',
	] );
	expect( seen ).toHaveLength( 1 );
	expect( seen[ 0 ][ TO ] ).toBe( 'caller' );
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

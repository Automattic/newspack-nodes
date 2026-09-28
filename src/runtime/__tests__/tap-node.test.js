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

test( 'fill passes the original through, then throws the target failure', () => {
	const head = new Node();
	head.name = 'alive';

	const seen = [];
	const failure = new Error( 'boom 5150' );
	const sink = new Node();
	sink.fill = ( m ) => {
		if ( 'alive/workers' === m[ TO ] ) {
			throw failure;
		}
		seen.push( [ ...m ] );
	};

	const t = new TapNode();
	t.sink = sink;
	t.target = [ 'alive/workers' ];

	const m = newMessage();
	m[ TO ] = 'caller';

	expect( () => t.fill( m ) ).toThrow( failure );
	expect( seen ).toHaveLength( 1 );
	expect( seen[ 0 ][ TO ] ).toBe( 'caller' );
} );

test( 'a failed passthrough joins the target failures it follows', () => {
	const head = new Node();
	head.name = 'alive';

	const sink = new Node();
	sink.fill = ( m ) => {
		throw new Error( `${ m[ TO ] } refused 6262` );
	};

	const t = new TapNode();
	t.sink = sink;
	t.target = [ 'alive/workers' ];
	const m = newMessage();
	m[ TO ] = 'caller';

	expect( () => t.fill( m ) ).toThrow(
		new AggregateError(
			[],
			'2 failures: alive/workers refused 6262 | caller refused 6262'
		)
	);
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

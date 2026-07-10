import { TeeNode } from '../tee-node';
import { Node } from '../node';
import { Core } from '../core';
import { TO, VALUE, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'connectNode appends to the array target', () => {
	const t = new TeeNode();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'connectNode is idempotent — duplicates are skipped (matches PHP Tee)', () => {
	const t = new TeeNode();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.connectNode( 'a' ); // duplicate, should NOT append again
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'fill stamps TO with each owner and forwards N times', () => {
	const a = new Node();
	a.name = 'a';
	const b = new Node();
	b.name = 'b';
	const ga = [];
	a.fill = ( m ) => ga.push( [ ...m ] );
	const gb = [];
	b.fill = ( m ) => gb.push( [ ...m ] );

	const router = new Node();
	router.name = '_router';
	const routed = [];
	router.fill = ( m ) => {
		routed.push( [ ...m ] );
		Core.node( m[ TO ] ).fill( m );
	};

	const t = new TeeNode();
	t.sink = router;
	t.connectNode( 'a' );
	t.connectNode( 'b' );

	const m = newMessage();
	m[ VALUE ] = 'hi';
	t.fill( m );
	expect( routed ).toHaveLength( 2 );
	expect( routed.map( ( r ) => r[ TO ] ).sort() ).toEqual( [ 'a', 'b' ] );
} );

test( 'fill with no targets is a no-op but still increments counter', () => {
	const t = new TeeNode();
	t.fill( newMessage() );
	expect( t.counter ).toBe( 1 );
} );

test( 'fill with targets but no sink does not throw', () => {
	const t = new TeeNode();
	t.connectNode( 'a' );
	expect( () => t.fill( newMessage() ) ).not.toThrow();
	expect( t.counter ).toBe( 1 );
} );

test( 'fill with a path target but no sink throws because it cannot route', () => {
	const router = new Node();
	router.name = '_router';
	const t = new TeeNode();
	t.target = [ '_router/a' ];

	expect( () => t.fill( newMessage() ) ).toThrow(
		'fill requires a wired sink'
	);
} );

test( 'fill logs and continues when a routed target throws', () => {
	const router = new Node();
	router.name = '_router';
	const sink = new Node();
	sink.fill = () => {
		throw new Error( 'target exploded' );
	};
	const t = new TeeNode();
	t.sink = sink;
	t.target = [ '_router/a' ];
	const spy = jest
		.spyOn( t, 'printLessOften' )
		.mockImplementation( () => {} );

	t.fill( newMessage() );

	expect( spy ).toHaveBeenCalledWith(
		expect.stringMatching( /^WARNING:.*target exploded/ )
	);
	spy.mockRestore();
} );

test( 'fill does not mutate caller TO when fanning out', () => {
	const sink = new Node();
	sink.fill = () => {};
	const t = new TeeNode();
	t.sink = sink;
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	const m = newMessage();
	m[ TO ] = 'caller-set';
	t.fill( m );
	expect( m[ TO ] ).toBe( 'caller-set' );
} );

test( 'disconnectNode removes one target from the fan-out array', () => {
	const t = new TeeNode();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.disconnectNode( 'a' );
	expect( t.target ).toEqual( [ 'b' ] );
} );

test( 'disconnectNode with a bare target is a value-filter no-op (matches PHP)', () => {
	// Tee::disconnect_node('') filters out '' entries — removes nothing here.
	const t = new TeeNode();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.disconnectNode();
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'disconnectNode for a missing target leaves the array untouched', () => {
	const t = new TeeNode();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.disconnectNode( 'missing' );
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'fill keeps a path-shaped target whose HEAD node is registered', () => {
	const head = new Node();
	head.name = 'alive';
	const router = new Node();
	router.name = '_router';
	router.fill = () => {};

	const t = new TeeNode();
	t.sink = router;
	t.target = [ 'alive/workers' ];
	t.fill( newMessage() );

	expect( t.target ).toEqual( [ 'alive/workers' ] );
} );

test( 'fill prunes a path-shaped target whose HEAD node is dead', () => {
	const router = new Node();
	router.name = '_router';
	router.fill = () => {};

	const t = new TeeNode();
	t.sink = router;
	t.target = [ 'gone/workers' ];
	t.fill( newMessage() );

	expect( t.target ).toEqual( [] );
} );

test( 'connectNode normalizes a string target before appending', () => {
	const t = new TeeNode();
	t.target = 'a';
	t.connectNode( 'b' );
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'disconnectNode clears a non-array target shape', () => {
	const t = new TeeNode();
	t.target = 'a';
	t.disconnectNode( 'a' );
	expect( t.target ).toEqual( [] );
} );

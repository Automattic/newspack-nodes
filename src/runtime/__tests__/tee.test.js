import { Tee } from '../tee';
import { Node } from '../node';
import { Core } from '../core';
import { TO, VALUE, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'connectNode appends to the array target', () => {
	const t = new Tee();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'connectNode is idempotent — duplicates are skipped (matches PHP Tee)', () => {
	const t = new Tee();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.connectNode( 'a' ); // duplicate, should NOT append again
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'fill stamps TO with each owner and forwards N times', () => {
	const a = new Node();
	a.setName( 'a' );
	const b = new Node();
	b.setName( 'b' );
	const ga = [];
	a.fill = ( m ) => ga.push( [ ...m ] );
	const gb = [];
	b.fill = ( m ) => gb.push( [ ...m ] );

	const router = new Node();
	router.setName( '_router' );
	const routed = [];
	router.fill = ( m ) => {
		routed.push( [ ...m ] );
		Core.node( m[ TO ] ).fill( m );
	};

	const t = new Tee();
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
	const t = new Tee();
	t.fill( newMessage() );
	expect( t.counter ).toBe( 1 );
} );

test( 'fill with targets but no sink does not throw', () => {
	const t = new Tee();
	t.connectNode( 'a' );
	expect( () => t.fill( newMessage() ) ).not.toThrow();
	expect( t.counter ).toBe( 1 );
} );

test( 'fill does not mutate caller TO when fanning out', () => {
	const sink = new Node();
	sink.fill = () => {};
	const t = new Tee();
	t.sink = sink;
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	const m = newMessage();
	m[ TO ] = 'caller-set';
	t.fill( m );
	expect( m[ TO ] ).toBe( 'caller-set' );
} );

test( 'disconnectNode removes one target from the fan-out array', () => {
	const t = new Tee();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.disconnectNode( 'a' );
	expect( t.target ).toEqual( [ 'b' ] );
} );

test( 'disconnectNode with a bare target is a value-filter no-op (matches PHP)', () => {
	// PHP Tee::disconnect_node('') filters out '' entries — on a normal fan-out
	// that removes nothing. (The verb resolves a bare target to FROM first.)
	const t = new Tee();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.disconnectNode();
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

test( 'disconnectNode for a missing target leaves the array untouched', () => {
	const t = new Tee();
	t.connectNode( 'a' );
	t.connectNode( 'b' );
	t.disconnectNode( 'missing' );
	expect( t.target ).toEqual( [ 'a', 'b' ] );
} );

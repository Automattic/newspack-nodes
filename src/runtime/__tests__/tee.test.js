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

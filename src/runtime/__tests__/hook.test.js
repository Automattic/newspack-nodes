import { Hook } from '../hook';
import { Node } from '../node';
import { VALUE, newMessage } from '../message';

test( 'filter true forwards message to sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( m[ VALUE ] );

	const h = new Hook( ( m ) => m[ VALUE ] === 'keep' );
	h.sink = sink;

	const a = newMessage();
	a[ VALUE ] = 'keep';
	const b = newMessage();
	b[ VALUE ] = 'drop';
	h.fill( a );
	h.fill( b );
	expect( got ).toEqual( [ 'keep' ] );
} );

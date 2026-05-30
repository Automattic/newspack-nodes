import { CallbackNode } from '../callback-node';
import { VALUE, newMessage } from '../message';

test( 'fill invokes the callback with the message', () => {
	const got = [];
	const cb = new CallbackNode( ( m ) => got.push( m[ VALUE ] ) );
	const m = newMessage();
	m[ VALUE ] = 'hello';
	cb.fill( m );
	expect( got ).toEqual( [ 'hello' ] );
} );

test( 'counter still increments via base Node fill', () => {
	const cb = new CallbackNode( () => {} );
	cb.fill( newMessage() );
	cb.fill( newMessage() );
	expect( cb.counter ).toBe( 2 );
} );

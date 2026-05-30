import { EchoNode } from '../echo-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	TM_BYTESTREAM,
	TM_ERROR,
} from '../message';

test( 'bounces a message back by setting TO=FROM', () => {
	const e = new EchoNode();
	const sent = [];
	e.sink = { fill: ( m ) => sent.push( m ) };
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'alpha';
	m[ TO ] = '';
	e.fill( m );
	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ TO ] ).toBe( 'alpha' );
} );

test( 'drops TM_ERROR with empty TO (no return path)', () => {
	const e = new EchoNode();
	const sent = [];
	e.sink = { fill: ( m ) => sent.push( m ) };
	const m = newMessage();
	m[ TYPE ] = TM_ERROR;
	m[ FROM ] = '';
	m[ TO ] = '';
	e.fill( m );
	expect( sent ).toHaveLength( 0 );
} );

test( 'TM_ERROR with non-empty FROM still bounces (the error has a return path)', () => {
	const e = new EchoNode();
	const sent = [];
	e.sink = { fill: ( m ) => sent.push( m ) };
	const m = newMessage();
	m[ TYPE ] = TM_ERROR;
	m[ FROM ] = 'alpha';
	m[ TO ] = '';
	e.fill( m );
	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ TO ] ).toBe( 'alpha' );
} );

test( 'counter bumps per message', () => {
	const e = new EchoNode();
	e.sink = { fill: () => {} };
	const m1 = newMessage();
	m1[ FROM ] = 'a';
	const m2 = newMessage();
	m2[ FROM ] = 'b';
	e.fill( m1 );
	e.fill( m2 );
	expect( e.counter ).toBe( 2 );
} );

import { EchoNode } from '../echo-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	TM_BYTESTREAM,
	TM_COMMAND,
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

test( 'drops a pathless TM_ERROR regardless of FROM (matches Tachikoma)', () => {
	const e = new EchoNode();
	const sent = [];
	e.sink = { fill: ( m ) => sent.push( m ) };
	const m = newMessage();
	m[ TYPE ] = TM_ERROR;
	m[ FROM ] = 'alpha';
	m[ TO ] = '';
	e.fill( m );
	expect( sent ).toHaveLength( 0 );
} );

test( 'with an owner, composes owner/to (symlink pathing)', () => {
	const e = new EchoNode();
	e.target = 'foo';
	const sent = [];
	e.sink = { fill: ( m ) => sent.push( m ) };
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ TO ] = 'bar';
	e.fill( m );
	expect( sent[ 0 ][ TO ] ).toBe( 'foo/bar' );
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

// TYPE is a bitmask (ADR-2). PHP's twin reads `$type & TM_ERROR`, so a composite
// TM_COMMAND|TM_ERROR drops there; exact equality here let it through, and an
// error with no return path is exactly what bounces to a producer not expecting it.
test( 'drops a COMPOSITE TM_ERROR with empty TO, as the PHP twin does', () => {
	const e = new EchoNode();
	const sent = [];
	e.sink = { fill: ( m ) => sent.push( m ) };
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_ERROR;
	m[ FROM ] = 'alpha';
	m[ TO ] = '';
	e.fill( m );
	expect( sent ).toHaveLength( 0 );
} );

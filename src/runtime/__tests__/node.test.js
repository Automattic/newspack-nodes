import { Node } from '../node';
import { Core } from '../core';
import { FROM, TO, VALUE, newMessage } from '../message';

beforeEach( () => Core.reset() );

test( 'setName registers in Core', () => {
	const n = new Node();
	n.setName( 'alice' );
	expect( Core.node( 'alice' ) ).toBe( n );
} );

test( 'rename moves the registry slot', () => {
	const n = new Node();
	n.setName( 'alice' );
	n.setName( 'bob' );
	expect( Core.node( 'alice' ) ).toBeNull();
	expect( Core.node( 'bob' ) ).toBe( n );
} );

test( 'rename collision throws', () => {
	const a = new Node();
	a.setName( 'alice' );
	const b = new Node();
	expect( () => b.setName( 'alice' ) ).toThrow( /already registered/ );
} );

test( 'fill stamps TO from target when message TO is empty', () => {
	const sink = new Node();
	sink.setName( 'sink' );
	const captured = [];
	sink.fill = ( m ) => captured.push( [ ...m ] );

	const n = new Node();
	n.sink = sink;
	n.target = 'sink';

	const m = newMessage();
	m[ VALUE ] = 'hi';
	n.fill( m );
	expect( captured[ 0 ][ TO ] ).toBe( 'sink' );
} );

test( 'fill does NOT overwrite an existing TO', () => {
	const sink = new Node();
	const captured = [];
	sink.fill = ( m ) => captured.push( [ ...m ] );

	const n = new Node();
	n.sink = sink;
	n.target = 'sink';

	const m = newMessage();
	m[ TO ] = 'preset';
	n.fill( m );
	expect( captured[ 0 ][ TO ] ).toBe( 'preset' );
} );

test( 'counter increments on each fill', () => {
	const sink = new Node();
	sink.fill = () => {};
	const n = new Node();
	n.sink = sink;
	expect( n.counter ).toBe( 0 );
	n.fill( newMessage() );
	n.fill( newMessage() );
	expect( n.counter ).toBe( 2 );
} );

test( 'stampMessage prepends name to FROM', () => {
	const n = new Node();
	const m = newMessage();
	m[ FROM ] = 'a/b';
	expect( n.stampMessage( m, 'c' ) ).toBe( true );
	expect( m[ FROM ] ).toBe( 'c/a/b' );
} );

test( 'stampMessage empty name returns false', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const n = new Node();
	const m = newMessage();
	expect( n.stampMessage( m, '' ) ).toBe( false );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	spy.mockRestore();
} );

test( 'stampMessage with FROM exceeding MAX_FROM_SIZE returns false', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const n = new Node();
	const m = newMessage();
	m[ FROM ] = 'x'.repeat( 1024 );
	expect( n.stampMessage( m, 'c' ) ).toBe( false );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	spy.mockRestore();
} );

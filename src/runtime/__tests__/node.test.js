import { Node } from '../node';
import { Core } from '../core';
import { FROM, TO, KEY, VALUE, newMessage } from '../message';

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

test( 'fill on a Node with no sink does not throw', () => {
	const n = new Node();
	expect( () => n.fill( newMessage() ) ).not.toThrow();
	expect( n.counter ).toBe( 1 );
} );

test( 'stampMessage on a message with empty FROM sets FROM to the name (no trailing slash)', () => {
	const n = new Node();
	const m = newMessage();
	expect( n.stampMessage( m, 'c' ) ).toBe( true );
	expect( m[ FROM ] ).toBe( 'c' );
} );

test( 'largestMsgSent tracks the largest VALUE byte size ever filled', () => {
	const sink = new Node();
	sink.fill = () => {};
	const n = new Node();
	n.sink = sink;

	const small = newMessage();
	small[ VALUE ] = 'hi';
	const large = newMessage();
	large[ VALUE ] = 'x'.repeat( 500 );
	const medium = newMessage();
	medium[ VALUE ] = 'medium';

	n.fill( small );
	expect( n.largestMsgSent ).toBe( 2 );
	n.fill( large );
	expect( n.largestMsgSent ).toBe( 500 );
	n.fill( medium ); // smaller than large — should NOT regress
	expect( n.largestMsgSent ).toBe( 500 );
} );

test( 'register requires the event to have been pre-declared', () => {
	const n = new Node();
	expect( () => n.register( 'UNKNOWN', 'listener', () => {} ) ).toThrow(
		/no such event/
	);
} );

test( 'declared event with closure listener fires on notify', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	const seen = [];
	n.register( 'HELLO', 'l1', ( p ) => {
		seen.push( p );
		return true;
	} );
	n.notify( 'HELLO', { v: 42 } );
	expect( seen ).toEqual( [ { v: 42 } ] );
} );

test( 'closure returning false unregisters itself', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	let calls = 0;
	n.register( 'HELLO', 'l1', () => {
		calls += 1;
		return false;
	} );
	n.notify( 'HELLO' );
	n.notify( 'HELLO' );
	expect( calls ).toBe( 1 );
} );

test( 'node-name listener mode forwards a TM_INFO to the named node', () => {
	Core.reset();
	const targetNode = new Node();
	targetNode.setName( 'listener' );
	const got = [];
	targetNode.fill = ( m ) => got.push( [ ...m ] );

	const n = new Node();
	n.name = 'producer';
	n.registrations.HELLO = {};
	n.register( 'HELLO', 'listener', null );

	n.notify( 'HELLO', 'payload-string' );
	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ KEY ] ).toBe( 'HELLO' );
	expect( got[ 0 ][ VALUE ] ).toBe( 'payload-string' );
	expect( got[ 0 ][ FROM ] ).toBe( 'producer' );
	expect( got[ 0 ][ TO ] ).toBe( 'listener' );
} );

test( 'setState caches payload and replays to late closure registrants', () => {
	const n = new Node();
	n.registrations.STATE = {};
	n.setState( 'STATE', 'cached' );
	const got = [];
	n.register( 'STATE', 'l1', ( p ) => {
		got.push( p );
		return true;
	} );
	expect( got ).toEqual( [ 'cached' ] );
} );

test( 'unregister stops further notifications', () => {
	const n = new Node();
	n.registrations.X = {};
	const got = [];
	n.register( 'X', 'l1', ( p ) => {
		got.push( p );
		return true;
	} );
	n.unregister( 'X', 'l1' );
	n.notify( 'X', 'after' );
	expect( got ).toEqual( [] );
} );

test( 'closure returning truthy stays registered across notifies', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	let calls = 0;
	n.register( 'HELLO', 'l1', () => {
		calls += 1;
		return true;
	} );
	n.notify( 'HELLO' );
	n.notify( 'HELLO' );
	expect( calls ).toBe( 2 );
} );

test( 'multiple closure listeners on the same event all fire', () => {
	const n = new Node();
	n.registrations.HELLO = {};
	const got = [];
	n.register( 'HELLO', 'a', () => {
		got.push( 'a' );
		return true;
	} );
	n.register( 'HELLO', 'b', () => {
		got.push( 'b' );
		return true;
	} );
	n.notify( 'HELLO' );
	expect( got.sort() ).toEqual( [ 'a', 'b' ] );
} );

test( 'notify on an undeclared event is a silent no-op', () => {
	const n = new Node();
	expect( () => n.notify( 'NEVER', 'data' ) ).not.toThrow();
} );

test( 'notify prunes a node-name listener whose target was removed', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const target = new Node();
	target.setName( 'listener' );
	const n = new Node();
	n.name = 'producer';
	n.registrations.EVT = {};
	n.register( 'EVT', 'listener', null );
	Core.unregisterNode( 'listener' );
	n.notify( 'EVT', 'data' );
	expect( n.registrations.EVT.listener ).toBeUndefined();
	spy.mockRestore();
} );

import { Node } from '../node';
import { Core } from '../core';
import {
	TYPE,
	FROM,
	TO,
	VALUE,
	newMessage,
	TM_BYTESTREAM,
	TM_INFO,
	TM_EOF,
	TM_COMMAND,
	TM_ERROR,
	TM_REQUEST,
} from '../message';

beforeEach( () => Core.reset() );

// dropMessage mirrors PHP Node::drop_message: rate-limited WARNING audit line.
describe( 'Node.dropMessage', () => {
	it( 'emits "WARNING: <error> - <type>" via printLessOften', () => {
		const n = new Node();
		n.name = 'q';
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = '';
		m[ TO ] = '';
		m[ VALUE ] = '';
		n.dropMessage( m, 'BAD_INPUT' );
		expect( spy ).toHaveBeenCalledTimes( 1 );
		expect( spy.mock.calls[ 0 ][ 0 ] ).toContain( 'WARNING: BAD_INPUT' );
		expect( spy.mock.calls[ 0 ][ 0 ] ).toContain( 'TM_BYTESTREAM' );
	} );

	it( 'omits from:/to: when both are empty', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = '';
		m[ TO ] = '';
		m[ VALUE ] = '';
		n.dropMessage( m, 'TEST_ERROR' );
		const line = spy.mock.calls[ 0 ][ 0 ];
		expect( line ).not.toContain( 'from:' );
		expect( line ).not.toContain( 'to:' );
	} );

	it( 'includes from:/to: when present', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_INFO;
		m[ FROM ] = 'alpha';
		m[ TO ] = 'beta';
		m[ VALUE ] = '';
		n.dropMessage( m, 'X' );
		const line = spy.mock.calls[ 0 ][ 0 ];
		expect( line ).toContain( 'from: alpha' );
		expect( line ).toContain( 'to: beta' );
	} );

	it( 'renders an object VALUE as JSON in the payload (payload-bearing type)', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_INFO;
		m[ FROM ] = '';
		m[ TO ] = '';
		m[ VALUE ] = { a: 1 };
		n.dropMessage( m, 'X' );
		expect( spy.mock.calls[ 0 ][ 0 ] ).toContain( 'payload: {"a":1}' );
	} );

	it( 'omits payload for a pure control type (TM_BYTESTREAM)', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = '';
		m[ TO ] = '';
		m[ VALUE ] = 'should-not-appear';
		n.dropMessage( m, 'X' );
		expect( spy.mock.calls[ 0 ][ 0 ] ).not.toContain( 'payload:' );
	} );

	it( 'drops the WARNING prefix for NOT_AVAILABLE (Perl parity)', () => {
		const n = new Node();
		jest.spyOn( Core, 'now' ).mockReturnValue( Core.initTime + 1000 );
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_INFO;
		m[ FROM ] = '';
		m[ TO ] = 'nobody';
		m[ VALUE ] = '';
		n.dropMessage( m, 'NOT_AVAILABLE' );
		const line = spy.mock.calls[ 0 ][ 0 ];
		expect( line ).toContain( 'NOT_AVAILABLE -' );
		expect( line ).not.toContain( 'WARNING: NOT_AVAILABLE' );
	} );

	it( 'routes NOT_AVAILABLE to printLessOften', () => {
		const n = new Node();
		jest.spyOn( Core, 'now' ).mockReturnValue( Core.initTime + 100 );
		const less = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = [];
		m[ TYPE ] = TM_INFO;
		m[ FROM ] = '';
		m[ TO ] = 'nobody-home';
		m[ VALUE ] = '';
		n.dropMessage( m, 'NOT_AVAILABLE' );
		expect( less ).toHaveBeenCalledTimes( 1 );
	} );
} );

/**
 * A message that was MINTED but never typed is a different failure from a naked
 * array with no TYPE at all — the first is our bug, the second is garbage on the
 * wire. TM_UNTYPED (a free high bit, matching no gate) tells them apart in the
 * audit; -1 could not, since as a bitmask it matches every type check there is.
 */
describe( 'TM_UNTYPED', () => {
	it( 'labels a minted-but-never-typed message TM_UNTYPED', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );

		n.dropMessage( newMessage(), 'message not addressed' );

		expect( spy.mock.calls[ 0 ][ 0 ] ).toContain( 'TM_UNTYPED' );
		expect( spy.mock.calls[ 0 ][ 0 ] ).not.toContain( 'TYPE_UNKNOWN' );
	} );

	it( 'still labels a naked array TYPE_UNKNOWN', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const naked = [];
		naked[ TYPE ] = 0;
		naked[ FROM ] = '';
		naked[ TO ] = '';

		n.dropMessage( naked, 'message not addressed' );

		expect( spy.mock.calls[ 0 ][ 0 ] ).toContain( 'TYPE_UNKNOWN' );
	} );

	it( 'matches no type gate — an untyped message is inert, not every type', () => {
		const type = newMessage()[ TYPE ];
		for ( const bit of [
			TM_BYTESTREAM,
			TM_EOF,
			TM_COMMAND,
			TM_ERROR,
			TM_INFO,
			TM_REQUEST,
		] ) {
			expect( type & bit ).toBe( 0 );
		}
	} );
} );

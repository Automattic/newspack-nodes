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
		const line = spy.mock.calls[ 0 ].join( '' );
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
		expect( spy.mock.calls[ 0 ].join( '' ) ).toContain(
			'payload: {"a":1}'
		);
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
 * The drop path is the one place flooding is expected, so the throttle has to
 * key on the stable category — PHP splits the line into a keyed head and an
 * unkeyed tail (`print_less_often( $head, $tail )`) for exactly this.
 */
describe( 'Node.dropMessage rate limiting', () => {
	it( 'collapses a flood of one category with differing tails to one line', () => {
		const spy = jest
			.spyOn( console, 'warn' )
			.mockImplementation( () => {} );
		const n = new Node();
		n.name = 'flooded';
		for ( const to of [ 'zulu', 'yankee', 'xray' ] ) {
			const m = newMessage();
			m[ TYPE ] = TM_INFO;
			m[ TO ] = to;
			m[ VALUE ] = `payload-${ to }`;
			n.dropMessage( m, 'NOT_AVAILABLE' );
		}
		expect( Core.recentLog ).toHaveLength( 1 );
		expect( Core.recentLog[ 0 ] ).toContain( 'to: zulu' );
		expect( Core.recentLog[ 0 ] ).toContain( 'payload: payload-zulu' );
		spy.mockRestore();
	} );

	it( 'still separates two different drop categories', () => {
		const spy = jest
			.spyOn( console, 'warn' )
			.mockImplementation( () => {} );
		const n = new Node();
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ TO ] = 'zulu';
		n.dropMessage( m, 'NOT_AVAILABLE' );
		n.dropMessage( m, 'sink refused' );
		expect( Core.recentLog ).toHaveLength( 2 );
		spy.mockRestore();
	} );
} );

// PHP redacts the VALUE at this line: the Vault UI ships credentials as a
// `--auth_password=…` token, and one NOT_AVAILABLE drop would print it.
describe( 'Node.dropMessage secret redaction', () => {
	it( 'masks a credential argument token', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = {
			name: 'save',
			arguments: [ '--host=db1', '--auth_password=zulu-swordfish' ],
		};
		n.dropMessage( m, 'NOT_AVAILABLE' );
		const line = spy.mock.calls[ 0 ].join( '' );
		expect( line ).not.toContain( 'zulu-swordfish' );
		expect( line ).toContain( '--auth_password=<redacted>' );
		expect( line ).toContain( '--host=db1' );
	} );

	it( 'masks a credential-named key at any depth', () => {
		const n = new Node();
		const spy = jest
			.spyOn( n, 'printLessOften' )
			.mockImplementation( () => {} );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = {
			name: 'save',
			payload: { label: 'spoke7', api_key: 'zulu-swordfish' },
		};
		n.dropMessage( m, 'NOT_AVAILABLE' );
		const line = spy.mock.calls[ 0 ].join( '' );
		expect( line ).not.toContain( 'zulu-swordfish' );
		expect( line ).toContain( '"api_key":"<redacted>"' );
		expect( line ).toContain( '"label":"spoke7"' );
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

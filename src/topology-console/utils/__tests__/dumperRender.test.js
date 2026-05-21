/**
 * Tests for the Dumper-render helpers; framing must match the substrate cli Dumper.
 */

import {
	dumperRender,
	buildDebugHeader1,
	buildDebugHeader2,
	TM_BYTESTREAM,
	TM_EOF,
	TM_PING,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_INFO,
	TM_STRUCT,
} from '../dumperRender';

describe( 'dumperRender', () => {
	it( 'drops TM_EOF silently', () => {
		expect(
			dumperRender( { type: TM_EOF, from: 'w', value: '' } )
		).toBeNull();
	} );

	it( 'unwraps TM_COMMAND|TM_RESPONSE payload as recv', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		expect(
			dumperRender( { type: t, value: { payload: 'ls result' } } )
		).toEqual( { kind: 'recv', text: 'ls result' } );
	} );

	it( 'drops TM_COMMAND|TM_RESPONSE with empty payload', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		expect(
			dumperRender( { type: t, value: { payload: '' } } )
		).toBeNull();
		expect( dumperRender( { type: t, value: null } ) ).toBeNull();
	} );

	it( 'unwraps TM_COMMAND|TM_ERROR as error', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_ERROR;
		expect(
			dumperRender( { type: t, value: { payload: 'bad arg' } } )
		).toEqual( { kind: 'error', text: 'bad arg' } );
	} );

	it( 'routes TM_ERROR to error kind with the raw value', () => {
		expect(
			dumperRender( { type: TM_ERROR, value: 'something went wrong' } )
		).toEqual( { kind: 'error', text: 'something went wrong' } );
	} );

	it( 'formats TM_PING as round trip time', () => {
		const past = Date.now() / 1000 - 0.05;
		const out = dumperRender( { type: TM_PING, value: String( past ) } );
		expect( out.kind ).toBe( 'info' );
		expect( out.text ).toMatch( /round trip time: .+ ms/ );
	} );

	it( 'stringifies TM_STRUCT object payloads', () => {
		const out = dumperRender( {
			type: TM_STRUCT,
			value: { foo: 'bar' },
		} );
		expect( out.kind ).toBe( 'recv' );
		expect( out.text ).toMatch( /"foo": "bar"/ );
	} );

	it( 'passes TM_STRUCT string payloads through', () => {
		expect(
			dumperRender( { type: TM_STRUCT, value: 'already serialized' } )
		).toEqual( { kind: 'recv', text: 'already serialized' } );
	} );

	it( 'renders TM_INFO and TM_BYTESTREAM as recv', () => {
		expect( dumperRender( { type: TM_INFO, value: 'some info' } ) ).toEqual(
			{ kind: 'recv', text: 'some info' }
		);
		expect(
			dumperRender( { type: TM_BYTESTREAM, value: 'hello world' } )
		).toEqual( { kind: 'recv', text: 'hello world' } );
	} );

	it( 'drops an unknown / zero type', () => {
		expect( dumperRender( { type: 0, value: 'noflag' } ) ).toBeNull();
	} );
} );

describe( 'buildDebugHeader1', () => {
	it( 'renders a single-line type/from header', () => {
		expect(
			buildDebugHeader1( { type: TM_BYTESTREAM, from: 'worker' } )
		).toBe( 'TM_BYTESTREAM from worker:' );
	} );

	it( 'pipe-joins combined flags', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		expect( buildDebugHeader1( { type: t, from: 'w' } ) ).toBe(
			'TM_COMMAND | TM_RESPONSE from w:'
		);
	} );
} );

describe( 'buildDebugHeader2', () => {
	it( 'renders the full envelope dump', () => {
		const out = buildDebugHeader2( {
			type: TM_INFO,
			from: 'worker',
			to: 'x',
			id: '1:2',
			key: 'k',
			ts: 1700000000,
			value: 'payload',
		} );
		expect( out ).toMatch( /^Message \{/ );
		expect( out ).toMatch( /type:\s+TM_INFO/ );
		expect( out ).toMatch( /from:\s+worker/ );
		expect( out ).toMatch( /value:\s+payload/ );
	} );
} );

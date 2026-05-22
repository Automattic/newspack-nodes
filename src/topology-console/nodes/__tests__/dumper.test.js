/**
 * Dumper node tests — the `_output` node. `_router` delivers typed-command
 * replies as POSITIONAL Messages; the Dumper renders each into the transcript,
 * mirroring the substrate cli Dumper. Transcript-only (canvas metadata + uptime
 * are their own nodes). Ports the old utils/dumperRender.test.js cases to the
 * node, plus the dump_node structured-render + no-[object Object] guards.
 */

import {
	Dumper,
	TRANSCRIPT_MAX,
	renderMessage,
	formatTypeLabel,
	stringifyValue,
	buildDebugHeader1,
	buildDebugHeader2,
} from '../dumper';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_EOF,
	TM_ERROR,
	TM_INFO,
	TM_PING,
	TM_RESPONSE,
	TM_STRUCT,
} from '../../../runtime/message';

// Build a positional Message with the given type/value (+ optional from).
function msg( type, value, from = 'worker' ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ FROM ] = from;
	m[ VALUE ] = value;
	return m;
}

function makeDumper( debugLevel = 0 ) {
	const debugLevelRef = { current: debugLevel };
	return { dumper: new Dumper( { debugLevelRef } ), debugLevelRef };
}

describe( 'renderMessage', () => {
	it( 'drops TM_EOF silently', () => {
		expect( renderMessage( msg( TM_EOF, '' ) ) ).toBeNull();
	} );

	it( 'unwraps TM_COMMAND|TM_RESPONSE payload as recv', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		expect(
			renderMessage( msg( t, { name: 'ls', payload: 'ls result' } ) )
		).toEqual( { kind: 'recv', text: 'ls result' } );
	} );

	it( 'drops TM_COMMAND|TM_RESPONSE with empty payload', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		expect( renderMessage( msg( t, { payload: '' } ) ) ).toBeNull();
		expect( renderMessage( msg( t, null ) ) ).toBeNull();
	} );

	it( 'unwraps TM_COMMAND|TM_ERROR as error', () => {
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_ERROR;
		expect(
			renderMessage( msg( t, { name: 'x', payload: 'bad arg' } ) )
		).toEqual( { kind: 'error', text: 'bad arg' } );
	} );

	it( 'routes TM_ERROR to error kind with the raw value', () => {
		expect(
			renderMessage( msg( TM_ERROR, 'something went wrong' ) )
		).toEqual( { kind: 'error', text: 'something went wrong' } );
	} );

	it( 'formats TM_PING as round trip time', () => {
		const past = Date.now() / 1000 - 0.05;
		const out = renderMessage( msg( TM_PING, String( past ) ) );
		expect( out.kind ).toBe( 'info' );
		expect( out.text ).toMatch( /round trip time: .+ ms/ );
	} );

	it( 'stringifies TM_STRUCT object payloads as JSON', () => {
		const out = renderMessage( msg( TM_STRUCT, { foo: 'bar' } ) );
		expect( out.kind ).toBe( 'recv' );
		expect( out.text ).toMatch( /"foo": "bar"/ );
	} );

	it( 'passes TM_STRUCT string payloads through', () => {
		expect(
			renderMessage( msg( TM_STRUCT, 'already serialized' ) )
		).toEqual( { kind: 'recv', text: 'already serialized' } );
	} );

	it( 'renders TM_INFO and TM_BYTESTREAM as recv', () => {
		expect( renderMessage( msg( TM_INFO, 'some info' ) ) ).toEqual( {
			kind: 'recv',
			text: 'some info',
		} );
		expect( renderMessage( msg( TM_BYTESTREAM, 'hello world' ) ) ).toEqual(
			{ kind: 'recv', text: 'hello world' }
		);
	} );

	it( 'renders a structured TM_COMMAND|TM_RESPONSE payload as JSON (not dropped)', () => {
		// dump_node's reply payload is a structure (de-double-encoded verbs), so
		// it must render as JSON, not get dropped for being non-string.
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		const out = renderMessage(
			msg( t, { name: 'dump_node', payload: { sink: 'x', counter: 3 } } )
		);
		expect( out ).not.toBeNull();
		expect( out.text ).toMatch( /"counter": 3/ );
		expect( out.text ).not.toContain( '[object Object]' );
	} );

	it( 'renders a structured TM_INFO value as JSON, not [object Object]', () => {
		const out = renderMessage( msg( TM_INFO, { a: 1 } ) );
		expect( out.text ).not.toContain( '[object Object]' );
		expect( out.text ).toMatch( /"a": 1/ );
	} );

	it( 'drops an unknown / zero type', () => {
		expect( renderMessage( msg( 0, 'noflag' ) ) ).toBeNull();
	} );
} );

describe( 'formatTypeLabel + stringifyValue', () => {
	it( 'pipe-joins combined flags', () => {
		// eslint-disable-next-line no-bitwise
		expect( formatTypeLabel( TM_COMMAND | TM_RESPONSE ) ).toBe(
			'TM_COMMAND | TM_RESPONSE'
		);
	} );

	it( 'renders an unknown type as a hex fallback', () => {
		expect( formatTypeLabel( 0 ) ).toMatch( /TM_UNKNOWN/ );
	} );

	it( 'stringifyValue: object → JSON, string → through, null → empty', () => {
		expect( stringifyValue( { a: 1 } ) ).toMatch( /"a": 1/ );
		expect( stringifyValue( 'x' ) ).toBe( 'x' );
		expect( stringifyValue( null ) ).toBe( '' );
	} );

	it( 'stringifyValue: falls back to String() on a circular object', () => {
		const circular = {};
		circular.self = circular;
		// Doesn't throw; produces some string (the [object Object] String() form).
		expect( typeof stringifyValue( circular ) ).toBe( 'string' );
	} );
} );

describe( 'buildDebugHeader1 / buildDebugHeader2 (positional)', () => {
	it( 'header1 renders a single-line type/from header', () => {
		expect( buildDebugHeader1( msg( TM_BYTESTREAM, '', 'worker' ) ) ).toBe(
			'TM_BYTESTREAM from worker:'
		);
	} );

	it( 'header2 renders the full envelope dump', () => {
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ TIMESTAMP ] = 1700000000;
		m[ FROM ] = 'worker';
		m[ TO ] = 'x';
		m[ ID ] = '1:2';
		m[ KEY ] = 'k';
		m[ VALUE ] = 'payload';
		const out = buildDebugHeader2( m );
		expect( out ).toMatch( /^Message \{/ );
		expect( out ).toMatch( /type:\s+TM_INFO/ );
		expect( out ).toMatch( /from:\s+worker/ );
		expect( out ).toMatch( /value:\s+payload/ );
	} );
} );

describe( 'Dumper node — transcript', () => {
	it( 'renders a TM_BYTESTREAM into the transcript as recv', () => {
		const { dumper } = makeDumper();
		dumper.fill( msg( TM_BYTESTREAM, 'hello' ) );
		expect( dumper.setStateCache.transcript ).toEqual( [
			expect.objectContaining( { kind: 'recv', text: 'hello' } ),
		] );
	} );

	it( 'renders a dump_node structured reply as JSON, not [object Object]', () => {
		const { dumper } = makeDumper();
		// eslint-disable-next-line no-bitwise
		const t = TM_COMMAND | TM_RESPONSE;
		dumper.fill(
			msg( t, { name: 'dump_node', payload: { sink: 'x', counter: 3 } } )
		);
		const entry = dumper.setStateCache.transcript[ 0 ];
		expect( entry.text ).toMatch( /"counter": 3/ );
		expect( entry.text ).not.toContain( '[object Object]' );
	} );

	it( 'drops TM_EOF silently', () => {
		const { dumper } = makeDumper();
		dumper.fill( msg( TM_EOF, '' ) );
		expect( dumper.setStateCache.transcript ?? [] ).toHaveLength( 0 );
	} );

	it( 'routes TM_ERROR to an error transcript entry', () => {
		const { dumper } = makeDumper();
		dumper.fill( msg( TM_ERROR, 'boom' ) );
		expect( dumper.setStateCache.transcript ).toEqual( [
			expect.objectContaining( { kind: 'error', text: 'boom' } ),
		] );
	} );

	it( 'strips trailing newlines from rendered transcript text', () => {
		const { dumper } = makeDumper();
		dumper.fill( msg( TM_BYTESTREAM, 'line\n\n' ) );
		expect( dumper.setStateCache.transcript[ 0 ].text ).toBe( 'line' );
	} );

	it( 'each transcript update emits a fresh array (so useNodeState re-renders)', () => {
		const { dumper } = makeDumper();
		dumper.fill( msg( TM_BYTESTREAM, 'a' ) );
		const first = dumper.setStateCache.transcript;
		dumper.fill( msg( TM_BYTESTREAM, 'b' ) );
		const second = dumper.setStateCache.transcript;
		expect( second ).not.toBe( first );
		expect( second.map( ( e ) => e.text ) ).toEqual( [ 'a', 'b' ] );
	} );

	it( 'caps the transcript at TRANSCRIPT_MAX entries', () => {
		const { dumper } = makeDumper();
		for ( let i = 0; i < TRANSCRIPT_MAX + 50; i++ ) {
			dumper.fill( msg( TM_BYTESTREAM, `msg-${ i }` ) );
		}
		const t = dumper.setStateCache.transcript;
		expect( t ).toHaveLength( TRANSCRIPT_MAX );
		expect( t[ 0 ].text ).toBe( 'msg-50' );
		expect( t[ TRANSCRIPT_MAX - 1 ].text ).toBe(
			`msg-${ TRANSCRIPT_MAX + 49 }`
		);
	} );

	it( 'works as a real sink target (router → dumper.fill)', () => {
		const { dumper } = makeDumper();
		const router = new Node();
		router.sink = dumper;
		router.fill( msg( TM_BYTESTREAM, 'via-sink' ) );
		expect( dumper.setStateCache.transcript[ 0 ].text ).toBe( 'via-sink' );
	} );
} );

describe( 'Dumper node — debug levels', () => {
	it( 'level 1 injects a header line before the curated render', () => {
		const { dumper } = makeDumper( 1 );
		dumper.fill( msg( TM_BYTESTREAM, 'hi' ) );
		const t = dumper.setStateCache.transcript;
		expect( t[ 0 ] ).toEqual(
			expect.objectContaining( {
				kind: 'info',
				text: 'TM_BYTESTREAM from worker:',
			} )
		);
		expect( t[ 1 ] ).toEqual(
			expect.objectContaining( { kind: 'recv', text: 'hi' } )
		);
	} );

	it( 'level 2 replaces the render with a full envelope dump', () => {
		const { dumper } = makeDumper( 2 );
		dumper.fill( msg( TM_BYTESTREAM, 'hi' ) );
		const t = dumper.setStateCache.transcript;
		expect( t ).toHaveLength( 1 );
		expect( t[ 0 ].kind ).toBe( 'info' );
		expect( t[ 0 ].text ).toMatch( /^Message \{/ );
	} );

	it( 'level 1 still surfaces a TM_EOF arrival as a header even though the curated render drops it', () => {
		const { dumper } = makeDumper( 1 );
		dumper.fill( msg( TM_EOF, '' ) );
		const t = dumper.setStateCache.transcript;
		expect( t ).toHaveLength( 1 );
		expect( t[ 0 ].text ).toBe( 'TM_EOF from worker:' );
	} );
} );

describe( 'Dumper node — append / clear', () => {
	it( 'append() adds a caller-supplied entry (REPL echo) to the same buffer', () => {
		const { dumper } = makeDumper();
		dumper.fill( msg( TM_BYTESTREAM, 'recv-line' ) );
		dumper.append( { kind: 'sent', text: 'ls' } );
		expect(
			dumper.setStateCache.transcript.map( ( e ) => e.kind )
		).toEqual( [ 'recv', 'sent' ] );
	} );

	it( 'append() entries each carry a unique key', () => {
		const { dumper } = makeDumper();
		dumper.append( { kind: 'sent', text: 'a' } );
		dumper.append( { kind: 'sent', text: 'b' } );
		const [ a, b ] = dumper.setStateCache.transcript;
		expect( a.key ).toBeTruthy();
		expect( b.key ).toBeTruthy();
		expect( a.key ).not.toBe( b.key );
	} );

	it( 'clear() empties the transcript and emits a fresh empty array', () => {
		const { dumper } = makeDumper();
		dumper.append( { kind: 'sent', text: 'a' } );
		dumper.clear();
		expect( dumper.setStateCache.transcript ).toEqual( [] );
	} );
} );

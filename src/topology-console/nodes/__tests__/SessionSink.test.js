/**
 * SessionSink tests — KEY routing (gui:auto/gui:uptime/transcript) and the shared transcript ring buffer.
 */

import { SessionSink, TRANSCRIPT_MAX } from '../SessionSink';
import {
	TM_BYTESTREAM,
	TM_EOF,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_STRUCT,
} from '../../utils/dumperRender';

function makeSink( debugLevel = 0 ) {
	const debugLevelRef = { current: debugLevel };
	const sink = new SessionSink( { debugLevelRef } );
	return { sink, debugLevelRef };
}

describe( 'SessionSink routing', () => {
	it( 'gui:auto feeds parseMetadata into the metadata state, not the transcript', () => {
		const { sink } = makeSink();
		sink.fill( {
			type: TM_STRUCT,
			from: 'worker',
			key: 'gui:auto',
			value: {
				n1: { class: 'Echo', counter: 5, target: 'n2' },
				n2: { class: 'Echo', counter: 3, target: '' },
			},
		} );
		const meta = sink.setStateCache.metadata;
		expect( meta.nodes ).toHaveLength( 2 );
		expect( sink.setStateCache.transcript ?? [] ).toHaveLength( 0 );
	} );

	it( 'routes a raw positional Message array (the SseConnector shape)', () => {
		const { sink } = makeSink();
		// fill() must accept the raw positional array, else gui:auto never matches.
		sink.fill( [
			TM_STRUCT, // TYPE
			Date.now() / 1000, // TIMESTAMP
			'worker', // FROM
			'', // TO
			'', // ID
			'gui:auto', // KEY
			{
				n1: { class: 'Echo', counter: 5, target: 'n2' },
				n2: { class: 'Echo', counter: 3, target: '' },
			}, // VALUE
		] );
		expect( sink.setStateCache.metadata.nodes ).toHaveLength( 2 );
		expect( sink.setStateCache.transcript ?? [] ).toHaveLength( 0 );
	} );

	it( 'gui:auto unwraps a {name,payload} command-response envelope', () => {
		const { sink } = makeSink();
		sink.fill( {
			// eslint-disable-next-line no-bitwise
			type: TM_COMMAND | TM_RESPONSE,
			from: 'worker',
			key: 'gui:auto',
			value: {
				name: 'dump_metadata',
				payload: {
					n1: { class: 'Echo', counter: 7, target: '' },
				},
			},
		} );
		expect( sink.setStateCache.metadata.nodes ).toHaveLength( 1 );
	} );

	it( 'gui:uptime keeps the right half and never reaches the transcript', () => {
		const { sink } = makeSink();
		sink.fill( {
			type: TM_BYTESTREAM,
			from: 'worker',
			key: 'gui:uptime',
			value: '09:44:52  up 0 days, 00:01:00\n',
		} );
		expect( sink.setStateCache.uptime ).toBe( '0 days, 00:01:00' );
		expect( sink.setStateCache.transcript ?? [] ).toHaveLength( 0 );
	} );

	it( 'renders an async TM_BYTESTREAM into the transcript as recv', () => {
		const { sink } = makeSink();
		sink.fill( { type: TM_BYTESTREAM, from: 'worker', value: 'hello' } );
		expect( sink.setStateCache.transcript ).toEqual( [
			expect.objectContaining( { kind: 'recv', text: 'hello' } ),
		] );
	} );

	it( 'drops TM_EOF silently', () => {
		const { sink } = makeSink();
		sink.fill( { type: TM_EOF, from: 'worker', value: '' } );
		expect( sink.setStateCache.transcript ?? [] ).toHaveLength( 0 );
	} );

	it( 'routes TM_ERROR to an error transcript entry', () => {
		const { sink } = makeSink();
		sink.fill( { type: TM_ERROR, from: 'worker', value: 'boom' } );
		expect( sink.setStateCache.transcript ).toEqual( [
			expect.objectContaining( { kind: 'error', text: 'boom' } ),
		] );
	} );

	it( 'strips trailing newlines from rendered transcript text', () => {
		const { sink } = makeSink();
		sink.fill( {
			type: TM_BYTESTREAM,
			from: 'worker',
			value: 'line\n\n',
		} );
		expect( sink.setStateCache.transcript[ 0 ].text ).toBe( 'line' );
	} );

	it( 'each transcript update emits a fresh array (so useNodeState re-renders)', () => {
		const { sink } = makeSink();
		sink.fill( { type: TM_BYTESTREAM, from: 'w', value: 'a' } );
		const first = sink.setStateCache.transcript;
		sink.fill( { type: TM_BYTESTREAM, from: 'w', value: 'b' } );
		const second = sink.setStateCache.transcript;
		expect( second ).not.toBe( first );
		expect( second.map( ( e ) => e.text ) ).toEqual( [ 'a', 'b' ] );
	} );

	it( 'caps the transcript at TRANSCRIPT_MAX entries', () => {
		const { sink } = makeSink();
		for ( let i = 0; i < TRANSCRIPT_MAX + 50; i++ ) {
			sink.fill( {
				type: TM_BYTESTREAM,
				from: 'w',
				value: `msg-${ i }`,
			} );
		}
		const t = sink.setStateCache.transcript;
		expect( t ).toHaveLength( TRANSCRIPT_MAX );
		expect( t[ 0 ].text ).toBe( 'msg-50' );
		expect( t[ TRANSCRIPT_MAX - 1 ].text ).toBe(
			`msg-${ TRANSCRIPT_MAX + 49 }`
		);
	} );
} );

describe( 'SessionSink debug levels', () => {
	it( 'level 1 injects a header line before the curated render', () => {
		const { sink } = makeSink( 1 );
		sink.fill( { type: TM_BYTESTREAM, from: 'worker', value: 'hi' } );
		const t = sink.setStateCache.transcript;
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
		const { sink } = makeSink( 2 );
		sink.fill( { type: TM_BYTESTREAM, from: 'worker', value: 'hi' } );
		const t = sink.setStateCache.transcript;
		expect( t ).toHaveLength( 1 );
		expect( t[ 0 ].kind ).toBe( 'info' );
		expect( t[ 0 ].text ).toMatch( /^Message \{/ );
	} );

	it( 'level 1 still surfaces a TM_EOF arrival as a header even though the curated render drops it', () => {
		const { sink } = makeSink( 1 );
		sink.fill( { type: TM_EOF, from: 'worker', value: '' } );
		const t = sink.setStateCache.transcript;
		expect( t ).toHaveLength( 1 );
		expect( t[ 0 ].text ).toBe( 'TM_EOF from worker:' );
	} );
} );

describe( 'SessionSink shared transcript', () => {
	it( 'append() adds a caller-supplied entry (REPL echo) to the same buffer', () => {
		const { sink } = makeSink();
		sink.fill( { type: TM_BYTESTREAM, from: 'w', value: 'recv-line' } );
		sink.append( { kind: 'sent', text: 'ls' } );
		expect( sink.setStateCache.transcript.map( ( e ) => e.kind ) ).toEqual(
			[ 'recv', 'sent' ]
		);
	} );

	it( 'append() entries each carry a unique key', () => {
		const { sink } = makeSink();
		sink.append( { kind: 'sent', text: 'a' } );
		sink.append( { kind: 'sent', text: 'b' } );
		const [ a, b ] = sink.setStateCache.transcript;
		expect( a.key ).toBeTruthy();
		expect( b.key ).toBeTruthy();
		expect( a.key ).not.toBe( b.key );
	} );

	it( 'clear() empties the transcript and emits a fresh empty array', () => {
		const { sink } = makeSink();
		sink.append( { kind: 'sent', text: 'a' } );
		sink.clear();
		expect( sink.setStateCache.transcript ).toEqual( [] );
	} );
} );

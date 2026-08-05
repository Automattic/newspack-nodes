/* global requestAnimationFrame */
/**
 * Dumper node tests — the `_output` node. `_router` delivers typed-command
 * replies as POSITIONAL Messages; the Dumper renders each into the transcript,
 * mirroring the substrate cli Dumper. Transcript-only (canvas metadata + uptime
 * are their own nodes). Ports the old utils/dumperRender.test.js cases to the
 * node, plus the dump_node structured-render + no-[object Object] guards.
 */

import { DumperNode, TRANSCRIPT_MAX } from '../dumper-node';
import { Node } from '../node';
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
} from '../message';

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
	const dumper = new DumperNode();
	dumper.debugLevelRef = debugLevelRef;
	// Synchronous publish scheduler so a single fill() flushes in-line — the
	// coalescing itself is proven in the flood suite with a manual scheduler.
	dumper._schedule = ( cb ) => cb();
	return { dumper, debugLevelRef };
}

// The rendered transcript for ONE filled message, at the given debug level.
function transcriptFor( message, debugLevel = 0 ) {
	const { dumper } = makeDumper( debugLevel );
	dumper.fill( message );
	return dumper.setStateCache.transcript ?? [];
}

// The single rendered entry, or null when the message rendered nothing.
function entryFor( message, debugLevel = 0 ) {
	const [ entry = null ] = transcriptFor( message, debugLevel );
	return entry;
}

describe( 'per-type render rules', () => {
	it( 'drops TM_EOF silently', () => {
		expect( transcriptFor( msg( TM_EOF, '' ) ) ).toEqual( [] );
	} );

	it( 'unwraps TM_COMMAND|TM_RESPONSE payload as recv', () => {
		const t = TM_COMMAND | TM_RESPONSE;
		expect(
			entryFor( msg( t, { name: 'ls', payload: 'ls result' } ) )
		).toEqual(
			expect.objectContaining( { kind: 'recv', text: 'ls result' } )
		);
	} );

	it( 'drops TM_COMMAND|TM_RESPONSE with empty payload', () => {
		const t = TM_COMMAND | TM_RESPONSE;
		expect( transcriptFor( msg( t, { payload: '' } ) ) ).toEqual( [] );
		expect( transcriptFor( msg( t, null ) ) ).toEqual( [] );
	} );

	it( 'unwraps TM_COMMAND|TM_ERROR as error', () => {
		const t = TM_COMMAND | TM_ERROR;
		expect(
			entryFor( msg( t, { name: 'x', payload: 'bad arg' } ) )
		).toEqual(
			expect.objectContaining( { kind: 'error', text: 'bad arg' } )
		);
	} );

	it( 'routes TM_ERROR to error kind with the raw value', () => {
		expect( entryFor( msg( TM_ERROR, 'something went wrong' ) ) ).toEqual(
			expect.objectContaining( {
				kind: 'error',
				text: 'something went wrong',
			} )
		);
	} );

	it( 'formats TM_PING as round trip time', () => {
		const past = Date.now() / 1000 - 0.05;
		const out = entryFor( msg( TM_PING, String( past ) ) );
		expect( out.kind ).toBe( 'info' );
		expect( out.text ).toMatch( /round trip time: .+ ms/ );
	} );

	it( 'stringifies TM_STRUCT object payloads as JSON', () => {
		const out = entryFor( msg( TM_STRUCT, { foo: 'bar' } ) );
		expect( out.kind ).toBe( 'recv' );
		expect( out.text ).toMatch( /"foo": "bar"/ );
	} );

	it( 'passes TM_STRUCT string payloads through', () => {
		expect( entryFor( msg( TM_STRUCT, 'already serialized' ) ) ).toEqual(
			expect.objectContaining( {
				kind: 'recv',
				text: 'already serialized',
			} )
		);
	} );

	it( 'renders TM_INFO and TM_BYTESTREAM as recv', () => {
		expect( entryFor( msg( TM_INFO, 'some info' ) ) ).toEqual(
			expect.objectContaining( { kind: 'recv', text: 'some info' } )
		);
		expect( entryFor( msg( TM_BYTESTREAM, 'hello world' ) ) ).toEqual(
			expect.objectContaining( { kind: 'recv', text: 'hello world' } )
		);
	} );

	it( 'renders a structured TM_COMMAND|TM_RESPONSE payload as JSON (not dropped)', () => {
		// Structured reply payload renders as JSON, not dropped.
		const t = TM_COMMAND | TM_RESPONSE;
		const out = entryFor(
			msg( t, { name: 'dump_node', payload: { sink: 'x', counter: 3 } } )
		);
		expect( out ).not.toBeNull();
		expect( out.text ).toMatch( /"counter": 3/ );
		expect( out.text ).not.toContain( '[object Object]' );
	} );

	it( 'renders a structured TM_INFO value as JSON, not [object Object]', () => {
		const out = entryFor( msg( TM_INFO, { a: 1 } ) );
		expect( out.text ).not.toContain( '[object Object]' );
		expect( out.text ).toMatch( /"a": 1/ );
	} );

	it( 'renders a nullish TM_INFO value as an empty recv entry', () => {
		expect( entryFor( msg( TM_INFO, null ) ) ).toEqual(
			expect.objectContaining( { kind: 'recv', text: '' } )
		);
	} );

	it( 'falls back to String() on a circular value instead of throwing', () => {
		const circular = {};
		circular.self = circular;
		expect( entryFor( msg( TM_STRUCT, circular ) ).text ).toBe(
			'[object Object]'
		);
	} );

	it( 'drops an unknown / zero type', () => {
		expect( transcriptFor( msg( 0, 'noflag' ) ) ).toEqual( [] );
	} );
} );

describe( 'debug headers (positional)', () => {
	it( 'level 1 pipe-joins combined type flags in the header', () => {
		const t = TM_COMMAND | TM_RESPONSE;
		expect(
			entryFor( msg( t, { name: 'ls', payload: 'out' } ), 1 ).text
		).toBe( 'TM_COMMAND | TM_RESPONSE from worker:' );
	} );

	it( 'level 1 renders an unknown type as a hex fallback', () => {
		expect( entryFor( msg( 0, 'noflag' ), 1 ).text ).toBe(
			'TM_UNKNOWN(0x0) from worker:'
		);
	} );

	it( 'level 2 renders the full envelope dump', () => {
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ TIMESTAMP ] = 1700000000;
		m[ FROM ] = 'worker';
		m[ TO ] = 'x';
		m[ ID ] = '1:2';
		m[ KEY ] = 'k';
		m[ VALUE ] = 'payload';
		const out = entryFor( m, 2 ).text;
		expect( out ).toMatch( /^Message \{/ );
		expect( out ).toMatch( /type:\s+TM_INFO/ );
		expect( out ).toMatch( /from:\s+worker/ );
		expect( out ).toMatch( /to:\s+x/ );
		expect( out ).toMatch( /id:\s+1:2/ );
		expect( out ).toMatch( /key:\s+k/ );
		expect( out ).toMatch( /timestamp:\s+1700000000 \(2023-11-14/ );
		expect( out ).toMatch( /value:\s+payload/ );
	} );

	it( 'level 2 indents a multi-line value under the value column', () => {
		const out = entryFor( msg( TM_STRUCT, { a: 1 } ), 2 ).text;
		expect( out ).toMatch( /value: {5}\{\n {17}"a": 1\n {15}\}\n\}$/ );
	} );

	it( 'level 2 trims a value trailing newline so a single newline (no blank line) precedes the closing brace', () => {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ VALUE ] = 'SEGMENT 1\n';
		const out = entryFor( m, 2 ).text;
		// The value sits directly above `}` — no whitespace-only wedge line.
		expect( out ).toMatch( /value:\s+SEGMENT 1\n}$/ );
		expect( out ).not.toMatch( /\n\s*\n}/ );
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

	it( 'stamps every pushed entry with a ts (epoch seconds) for the timeline', () => {
		const nowMs = 1_777_123_456_000;
		const spy = jest.spyOn( Date, 'now' ).mockReturnValue( nowMs );
		try {
			const { dumper } = makeDumper();
			dumper.fill( msg( TM_BYTESTREAM, 'traced' ) );
			dumper.append( { kind: 'sent', text: 'ls' } );
			const [ recv, sent ] = dumper.setStateCache.transcript;
			expect( recv.ts ).toBe( nowMs / 1000 );
			expect( sent.ts ).toBe( nowMs / 1000 );
		} finally {
			spy.mockRestore();
		}
	} );

	it( 'clear() empties the transcript and emits a fresh empty array', () => {
		const { dumper } = makeDumper();
		dumper.append( { kind: 'sent', text: 'a' } );
		dumper.clear();
		expect( dumper.setStateCache.transcript ).toEqual( [] );
	} );

	it( 'restore() seeds a persisted transcript, notifies, and appends build on it [87]', () => {
		const { dumper } = makeDumper();
		dumper.restore( [
			{ kind: 'sent', text: 'a' },
			{ kind: 'recv', text: 'b' },
		] );
		expect( dumper.setStateCache.transcript ).toHaveLength( 2 );
		expect( dumper.setStateCache.transcript[ 1 ].text ).toBe( 'b' );
		// A later append builds on the restored transcript, not a fresh one.
		dumper.append( { kind: 'sent', text: 'c' } );
		expect(
			dumper.setStateCache.transcript.map( ( e ) => e.text )
		).toEqual( [ 'a', 'b', 'c' ] );
	} );

	it( 'restore() caps a too-long persisted transcript to TRANSCRIPT_MAX [87]', () => {
		const { dumper } = makeDumper();
		const huge = Array.from(
			{ length: TRANSCRIPT_MAX + 25 },
			( _, i ) => ( {
				kind: 'recv',
				text: `n${ i }`,
			} )
		);
		dumper.restore( huge );
		expect( dumper.setStateCache.transcript ).toHaveLength(
			TRANSCRIPT_MAX
		);
		expect(
			dumper.setStateCache.transcript[ TRANSCRIPT_MAX - 1 ].text
		).toBe( `n${ TRANSCRIPT_MAX + 24 }` );
	} );
} );

describe( 'Dumper — captureNextReply (one-shot command-reply capture)', () => {
	it( 'lets an unanswered arm expire instead of firing on a later reply', () => {
		// With no expiry, a verb that never replied left the slot armed, and the
		// NEXT matching reply — possibly minutes later, belonging to a different
		// user action — fired the stale callback.
		jest.useFakeTimers();
		try {
			const dumper = new DumperNode();
			let fired = 0;
			dumper.captureNextReply( 'dump_config', () => fired++ );

			jest.advanceTimersByTime( DumperNode.CAPTURE_TTL_MS + 1 );

			const m = newMessage();
			m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
			m[ VALUE ] = { name: 'dump_config', payload: 'late' };
			dumper.fill( m );

			expect( fired ).toBe( 0 );
			// And the expired slot does not block a fresh arm.
			expect( () =>
				dumper.captureNextReply( 'dump_config', () => {} )
			).not.toThrow();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'refuses a second arm while one is pending, instead of dropping it', () => {
		// The slot is a single field. Silently superseding meant a caller that
		// dispatched two verbs lost the first reply with no signal at all.
		const dumper = new DumperNode();
		dumper.captureNextReply( 'dump_config', () => {} );
		expect( () =>
			dumper.captureNextReply( 'other_verb', () => {} )
		).toThrow( /still pending/ );
	} );

	const reply = ( name, payload, kind = TM_RESPONSE ) =>
		msg( TM_COMMAND | kind, { name, payload } );

	it( 'captures the next matching command reply payload via the callback', () => {
		const { dumper } = makeDumper();
		const seen = [];
		dumper.captureNextReply( 'dump_config', ( payload, isError ) =>
			seen.push( { payload, isError } )
		);
		dumper.fill( reply( 'dump_config', 'make_node Echo captured_e\n' ) );
		expect( seen ).toEqual( [
			{ payload: 'make_node Echo captured_e\n', isError: false },
		] );
	} );

	it( 'is one-shot — a later reply does not re-fire the callback', () => {
		const { dumper } = makeDumper();
		let calls = 0;
		dumper.captureNextReply( 'dump_config', () => calls++ );
		dumper.fill( reply( 'dump_config', 'first\n' ) );
		dumper.fill( reply( 'dump_config', 'second\n' ) );
		expect( calls ).toBe( 1 );
	} );

	it( 'ignores replies whose command name differs from the requested verb', () => {
		const { dumper } = makeDumper();
		let fired = false;
		dumper.captureNextReply( 'dump_config', () => ( fired = true ) );
		dumper.fill( reply( 'ls', 'node-a\nnode-b\n' ) );
		expect( fired ).toBe( false );
	} );

	it( 'surfaces a matching TM_ERROR reply with isError=true', () => {
		const { dumper } = makeDumper();
		const seen = [];
		dumper.captureNextReply( 'dump_config', ( payload, isError ) =>
			seen.push( { payload, isError } )
		);
		dumper.fill( reply( 'dump_config', 'boom', TM_ERROR ) );
		expect( seen ).toEqual( [ { payload: 'boom', isError: true } ] );
	} );

	it( 'still renders the captured reply into the transcript (non-invasive)', () => {
		const { dumper } = makeDumper();
		dumper.captureNextReply( 'dump_config', () => {} );
		dumper.fill( reply( 'dump_config', 'make_node Echo captured_e\n' ) );
		expect( dumper.setStateCache.transcript ).toEqual( [
			expect.objectContaining( {
				kind: 'recv',
				text: 'make_node Echo captured_e',
			} ),
		] );
	} );
} );

describe( 'Dumper — flood coalescing (connected-to-firehose crash fix)', () => {
	// A manual scheduler: capture the flush callback instead of running it, so
	// the test controls exactly when (if) a publish happens.
	function manualDumper() {
		const debugLevelRef = { current: 0 };
		const dumper = new DumperNode();
		dumper.debugLevelRef = debugLevelRef;
		let pending = null;
		dumper._schedule = ( cb ) => {
			pending = cb;
			return 1;
		};
		dumper._cancelSchedule = () => {
			pending = null;
		};
		return {
			dumper,
			flush: () => pending && pending(),
			pending: () => pending,
		};
	}

	it( 'coalesces 50k stream messages into ONE throttled publish, not one per message', () => {
		const { dumper, flush, pending } = manualDumper();
		let renders = 0;
		dumper.register( 'transcript', 'test/counter', () => {
			renders++;
			return true;
		} );
		renders = 0;
		for ( let i = 0; i < 50000; i++ ) {
			dumper.fill( msg( TM_BYTESTREAM, `line-${ i }` ) );
		}
		// No per-message React render / localStorage write: nothing published yet.
		expect( renders ).toBe( 0 );
		// Exactly one flush is queued regardless of message count.
		expect( pending() ).toBeInstanceOf( Function );
		flush();
		expect( renders ).toBe( 1 );
	} );

	it( 'keeps the transcript bounded under a 50k flood', () => {
		const { dumper, flush } = manualDumper();
		for ( let i = 0; i < 50000; i++ ) {
			dumper.fill( msg( TM_BYTESTREAM, `line-${ i }` ) );
		}
		flush();
		expect( dumper.setStateCache.transcript.length ).toBeLessThanOrEqual(
			TRANSCRIPT_MAX + 1
		);
	} );

	it( 'surfaces a rate-limited drop notice counting the flooded lines', () => {
		const { dumper, flush } = manualDumper();
		const total = 50000;
		for ( let i = 0; i < total; i++ ) {
			dumper.fill( msg( TM_BYTESTREAM, `line-${ i }` ) );
		}
		flush();
		const t = dumper.setStateCache.transcript;
		const notice = t[ t.length - 1 ];
		expect( notice.kind ).toBe( 'info' );
		expect( notice.text ).toMatch(
			new RegExp( String( total - TRANSCRIPT_MAX ) )
		);
	} );

	it( 'defers the publish to the animation-frame scheduler when none is injected', async () => {
		const dumper = new DumperNode();
		let renders = 0;
		dumper.register( 'transcript', 'test/raf', () => {
			renders++;
			return true;
		} );
		dumper.fill( msg( TM_BYTESTREAM, 'frame' ) );
		// Deferred: not published synchronously in the fill() call.
		expect( renders ).toBe( 0 );
		await new Promise( ( resolve ) =>
			requestAnimationFrame( () => resolve() )
		);
		expect( renders ).toBe( 1 );
		expect( dumper.setStateCache.transcript[ 0 ].text ).toBe( 'frame' );
	} );

	it( 'cancels a pending publish on removeNode (no post-teardown flush)', () => {
		const { dumper, flush } = manualDumper();
		dumper.fill( msg( TM_BYTESTREAM, 'pending' ) );
		dumper.removeNode();
		// After teardown, running the captured callback must be a no-op.
		expect( () => flush() ).not.toThrow();
	} );
} );

describe( 'Dumper — no-arg ctor + public-property dep', () => {
	it( 'constructs with no args; debugLevelRef defaults to a safe ref', () => {
		const dumper = new DumperNode();
		expect( dumper.debugLevelRef ).toBeDefined();
		expect( dumper.debugLevelRef.current ).toBe( 0 );
	} );

	it( 'has an empty arguments schema (deps are programmatic, not config)', () => {
		const schema = DumperNode.nodeSchema();
		expect( schema.arguments ).toEqual( [] );
	} );

	it( 'declares has_target:false (the _output terminal never forwards)', () => {
		expect( DumperNode.nodeSchema().has_target ).toBe( false );
	} );

	it( 'accepts the debugLevelRef as a public property after construction', () => {
		const dumper = new DumperNode();
		dumper._schedule = ( cb ) => cb();
		const debugLevelRef = { current: 2 };
		dumper.debugLevelRef = debugLevelRef;
		// Level 2 replaces the curated render with the full envelope dump.
		dumper.fill( msg( TM_BYTESTREAM, 'hi' ) );
		const t = dumper.setStateCache.transcript;
		expect( t ).toHaveLength( 1 );
		expect( t[ 0 ].text ).toMatch( /^Message \{/ );
	} );

	it( 'still renders the transcript when no debugLevelRef is supplied', () => {
		const dumper = new DumperNode();
		dumper._schedule = ( cb ) => cb();
		dumper.fill( msg( TM_BYTESTREAM, 'hello' ) );
		expect( dumper.setStateCache.transcript[ 0 ] ).toEqual(
			expect.objectContaining( { kind: 'recv', text: 'hello' } )
		);
	} );
} );

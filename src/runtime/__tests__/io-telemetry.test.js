import { IoTelemetry, byteLength } from '../io-telemetry';

// Pinned literals, not the module's own constants: a test that imports the
// value it asserts on cannot notice the value changing.
const OVERVIEW_STORAGE_KEY = 'newspack-nodes:debug:overview';
const RING_SECONDS = 3600;
const MAX_SAMPLES = 720;
const MAX_MESSAGES = 200;

beforeEach( () => {
	IoTelemetry.reset();
	try {
		window.localStorage.removeItem( OVERVIEW_STORAGE_KEY );
	} catch ( _e ) {
		// ignore
	}
} );

describe( 'cross-bundle singleton', () => {
	test( 'the exported IoTelemetry IS the window-global singleton', () => {
		expect( window.__newspackNodesIoTelemetry ).toBe( IoTelemetry );
	} );

	test( "a second bundle's import resolves to the same instance", () => {
		jest.resetModules();
		const { IoTelemetry: reimported } = require( '../io-telemetry' );
		expect( reimported ).toBe( IoTelemetry );
	} );
} );

describe( 'byteLength', () => {
	test( 'counts UTF-8 bytes, not characters', () => {
		expect( byteLength( 'abc' ) ).toBe( 3 );
		// é is 2 bytes, € is 3 bytes in UTF-8.
		expect( byteLength( 'é' ) ).toBe( 2 );
		expect( byteLength( '€' ) ).toBe( 3 );
	} );

	test( 'empty / nullish is zero', () => {
		expect( byteLength( '' ) ).toBe( 0 );
		expect( byteLength( null ) ).toBe( 0 );
		expect( byteLength( undefined ) ).toBe( 0 );
	} );
} );

describe( 'SSE connection uptime', () => {
	test( 'a fresh instance has no SSE connect timestamp', () => {
		expect( IoTelemetry.snapshot().sseConnectedAt ).toBeNull();
	} );

	test( 'markSseConnected records the connect timestamp in the snapshot', () => {
		IoTelemetry.markSseConnected( 1000 );
		expect( IoTelemetry.snapshot().sseConnectedAt ).toBe( 1000 );
	} );

	test( 'the default connect timestamp is whole seconds (no fractional uptime)', () => {
		// Date.now()/1000 is a float; storing it raw renders "51.684…s" not "51s".
		IoTelemetry.markSseConnected();
		expect(
			Number.isInteger( IoTelemetry.snapshot().sseConnectedAt )
		).toBe( true );
	} );

	test( 'markSseDisconnected clears the connect timestamp', () => {
		IoTelemetry.markSseConnected( 1000 );
		IoTelemetry.markSseDisconnected();
		expect( IoTelemetry.snapshot().sseConnectedAt ).toBeNull();
	} );

	test( 'a stats reset (clear) keeps the connect timestamp — the stream is still up', () => {
		IoTelemetry.markSseConnected( 1000 );
		IoTelemetry.clear();
		expect( IoTelemetry.snapshot().sseConnectedAt ).toBe( 1000 );
	} );
} );

describe( 'cumulative counters', () => {
	test( 'recordIn accumulates bytes and a default message count of 1', () => {
		IoTelemetry.recordIn( 100 );
		IoTelemetry.recordIn( 50 );
		const s = IoTelemetry.snapshot();
		expect( s.bytesIn ).toBe( 150 );
		expect( s.msgsIn ).toBe( 2 );
	} );

	test( 'recordIn honors an explicit message count', () => {
		IoTelemetry.recordIn( 200, 3 );
		const s = IoTelemetry.snapshot();
		expect( s.bytesIn ).toBe( 200 );
		expect( s.msgsIn ).toBe( 3 );
	} );

	test( 'recordOut accumulates request bytes and counts', () => {
		IoTelemetry.recordOut( 80, 2 );
		const s = IoTelemetry.snapshot();
		expect( s.bytesOut ).toBe( 80 );
		expect( s.msgsOut ).toBe( 2 );
	} );

	test( 'recordWarning, recordError, recordDebug accumulate', () => {
		IoTelemetry.recordWarning();
		IoTelemetry.recordWarning();
		IoTelemetry.recordError();
		IoTelemetry.recordError( 2 );
		IoTelemetry.recordDebug();
		const s = IoTelemetry.snapshot();
		expect( s.warnings ).toBe( 2 );
		expect( s.errors ).toBe( 3 );
		expect( s.debug ).toBe( 1 );
	} );

	test( 'record* with text appends classified messages in order', () => {
		IoTelemetry.recordDebug( 'just a trace' );
		IoTelemetry.recordWarning( 'WARNING: disk filling up' );
		IoTelemetry.recordError( 1, 'ERROR: boom' );
		const { messages } = IoTelemetry.snapshot();
		expect( messages.map( ( m ) => [ m.level, m.text ] ) ).toEqual( [
			[ 'debug', 'just a trace' ],
			[ 'warning', 'WARNING: disk filling up' ],
			[ 'error', 'ERROR: boom' ],
		] );
	} );

	test( 'record* without text counts but adds no message row', () => {
		IoTelemetry.recordError(); // e.g. a TM_ERROR frame carrying no text
		const s = IoTelemetry.snapshot();
		expect( s.errors ).toBe( 1 );
		expect( s.messages ).toEqual( [] );
	} );

	test( 'clear zeroes data + drops the persisted series but keeps subscribers', () => {
		IoTelemetry.recordIn( 100 );
		IoTelemetry.recordWarning( 'WARNING: x' );
		IoTelemetry.sample( 0 );
		IoTelemetry.sample( 5 );
		window.localStorage.setItem( OVERVIEW_STORAGE_KEY, '[[1,2,3,4,5]]' );
		let notified = 0;
		IoTelemetry.subscribe( () => ( notified += 1 ) );

		IoTelemetry.clear();

		const s = IoTelemetry.snapshot();
		expect( s.bytesIn ).toBe( 0 );
		expect( s.warnings ).toBe( 0 );
		expect( s.messages ).toEqual( [] );
		expect( IoTelemetry.getSeries() ).toEqual( [] );
		expect(
			window.localStorage.getItem( OVERVIEW_STORAGE_KEY )
		).toBeNull();
		// Subscriber kept (not dropped like reset) and notified of the clear.
		expect( notified ).toBeGreaterThan( 0 );
	} );

	test( 'clear moves messageSeq, so a seq-keyed memo re-renders the empty list', () => {
		for ( let i = 0; i < 5; i++ ) {
			IoTelemetry.recordDebug( `DEBUG: line ${ i }` );
		}
		const before = IoTelemetry.snapshot().messageSeq;
		expect( before ).toBe( 5 );

		IoTelemetry.clear();

		// Unchanged, the overlay's useMemo keeps showing the cleared lines.
		expect( IoTelemetry.snapshot().messageSeq ).not.toBe( before );
	} );

	test( 'the message list is capped at MAX_MESSAGES (oldest dropped)', () => {
		for ( let i = 0; i < MAX_MESSAGES + 10; i++ ) {
			IoTelemetry.recordDebug( `m${ i }` );
		}
		const { messages } = IoTelemetry.snapshot();
		expect( messages.length ).toBe( MAX_MESSAGES );
		expect( messages[ 0 ].text ).toBe( 'm10' );
	} );

	test( 'reset clears every counter and the series', () => {
		IoTelemetry.recordIn( 10 );
		IoTelemetry.recordOut( 10 );
		IoTelemetry.recordError( 1, 'ERROR: x' );
		IoTelemetry.recordDebug( 'trace' );
		IoTelemetry.sample( 0 );
		IoTelemetry.sample( 5 );
		IoTelemetry.reset();
		const s = IoTelemetry.snapshot();
		expect( s ).toEqual( {
			bytesIn: 0,
			bytesOut: 0,
			msgsIn: 0,
			msgsOut: 0,
			warnings: 0,
			errors: 0,
			debug: 0,
			// Monotonic render key by design: never repeats across a reset.
			messageSeq: expect.any( Number ),
			sseConnectedAt: null,
			messages: [],
		} );
		expect( IoTelemetry.getSeries() ).toEqual( [] );
	} );
} );

describe( 'sample / rate series', () => {
	test( 'the first sample sets a baseline and emits no point', () => {
		IoTelemetry.recordIn( 100 );
		IoTelemetry.sample( 0 );
		expect( IoTelemetry.getSeries() ).toEqual( [] );
	} );

	test( 'the second sample emits per-second rates from the delta', () => {
		IoTelemetry.recordIn( 100, 2 ); // bytesIn 100, msgsIn 2
		IoTelemetry.recordOut( 40, 1 ); // bytesOut 40, msgsOut 1
		IoTelemetry.sample( 0 ); // baseline
		IoTelemetry.recordIn( 100, 2 ); // now bytesIn 200, msgsIn 4
		IoTelemetry.recordOut( 40, 1 ); // now bytesOut 80, msgsOut 2
		IoTelemetry.sample( 5 ); // dt = 5s
		const series = IoTelemetry.getSeries();
		expect( series ).toHaveLength( 1 );
		// [ t, msgInRate, msgOutRate, byteInRate, byteOutRate ]
		const [ t, mIn, mOut, bIn, bOut ] = series[ 0 ];
		expect( t ).toBe( 5 );
		expect( mIn ).toBeCloseTo( 2 / 5 );
		expect( mOut ).toBeCloseTo( 1 / 5 );
		expect( bIn ).toBeCloseTo( 100 / 5 );
		expect( bOut ).toBeCloseTo( 40 / 5 );
	} );

	test( 'a zero or negative dt emits no point (clock skew guard)', () => {
		IoTelemetry.sample( 10 );
		IoTelemetry.sample( 10 );
		IoTelemetry.sample( 5 );
		expect( IoTelemetry.getSeries() ).toEqual( [] );
	} );

	test( 'the ring is capped at MAX_SAMPLES (oldest dropped)', () => {
		// One baseline, then MAX_SAMPLES + 10 emitting samples at 5s cadence.
		let t = 0;
		IoTelemetry.sample( t );
		for ( let i = 0; i < MAX_SAMPLES + 10; i++ ) {
			t += 5;
			IoTelemetry.recordIn( 1 );
			IoTelemetry.sample( t );
		}
		expect( IoTelemetry.getSeries().length ).toBe( MAX_SAMPLES );
	} );

	test( 'samples older than the 1h window are dropped by age', () => {
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 0 ); // baseline
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 5 ); // emits a point at t=5
		expect( IoTelemetry.getSeries() ).toHaveLength( 1 );
		// Jump forward past the window; the old point must age out.
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( RING_SECONDS + 10 );
		const series = IoTelemetry.getSeries();
		expect( series ).toHaveLength( 1 );
		expect( series[ 0 ][ 0 ] ).toBe( RING_SECONDS + 10 );
	} );
} );

describe( 'revision', () => {
	test( 'starts at 0 and increments only on an emitting sample', () => {
		expect( IoTelemetry.revision ).toBe( 0 );
		IoTelemetry.sample( 0 ); // baseline, no emit
		expect( IoTelemetry.revision ).toBe( 0 );
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 5 ); // emit
		expect( IoTelemetry.revision ).toBe( 1 );
		IoTelemetry.sample( 5 ); // dt=0, no emit
		expect( IoTelemetry.revision ).toBe( 1 );
	} );
} );

describe( 'subscribe', () => {
	test( 'subscribers are notified on an emitting sample', () => {
		const calls = [];
		const unsub = IoTelemetry.subscribe( () => calls.push( 1 ) );
		IoTelemetry.sample( 0 ); // baseline, no emit, no notify
		expect( calls ).toHaveLength( 0 );
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 5 ); // emits
		expect( calls ).toHaveLength( 1 );
		unsub();
		IoTelemetry.recordIn( 1 );
		IoTelemetry.sample( 10 );
		expect( calls ).toHaveLength( 1 );
	} );
} );

describe( 'persistence', () => {
	test( 'sample persists the series to localStorage', () => {
		IoTelemetry.recordIn( 100 );
		IoTelemetry.sample( 0 );
		IoTelemetry.recordIn( 100 );
		IoTelemetry.sample( 5 );
		const raw = window.localStorage.getItem( OVERVIEW_STORAGE_KEY );
		expect( JSON.parse( raw ) ).toEqual( IoTelemetry.getSeries() );
	} );

	test( 'load restores a persisted series, dropping samples older than 1h', () => {
		const now = 100000;
		const fresh = [ now - 10, 1, 0, 5, 0 ];
		const stale = [ now - RING_SECONDS - 100, 9, 9, 9, 9 ];
		window.localStorage.setItem(
			OVERVIEW_STORAGE_KEY,
			JSON.stringify( [ stale, fresh ] )
		);
		IoTelemetry.reset();
		IoTelemetry.load( now );
		expect( IoTelemetry.getSeries() ).toEqual( [ fresh ] );
	} );

	test( 'load tolerates malformed storage', () => {
		window.localStorage.setItem( OVERVIEW_STORAGE_KEY, 'not json' );
		IoTelemetry.reset();
		expect( () => IoTelemetry.load( 0 ) ).not.toThrow();
		expect( IoTelemetry.getSeries() ).toEqual( [] );
	} );
} );

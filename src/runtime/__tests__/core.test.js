import { Core } from '../core';
import { TYPE, VALUE, TM_BYTESTREAM } from '../message';
import { IoTelemetry } from '../io-telemetry';

beforeEach( () => Core.reset() );

test( 'stderr classifies into IoTelemetry debug/warning/error by prefix, with text', () => {
	const warn = jest.spyOn( IoTelemetry, 'recordWarning' );
	const err = jest.spyOn( IoTelemetry, 'recordError' );
	const dbg = jest.spyOn( IoTelemetry, 'recordDebug' );
	const con = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	try {
		Core.stderr( 'WARNING: low disk' );
		Core.stderr( 'ERROR: boom' );
		Core.stderr( 'just a trace' );
		expect( warn ).toHaveBeenCalledWith(
			expect.stringContaining( 'WARNING: low disk' )
		);
		expect( err ).toHaveBeenCalledWith(
			1,
			expect.stringContaining( 'ERROR: boom' )
		);
		expect( dbg ).toHaveBeenCalledWith(
			expect.stringContaining( 'just a trace' )
		);
	} finally {
		warn.mockRestore();
		err.mockRestore();
		dbg.mockRestore();
		con.mockRestore();
	}
} );

describe( 'cross-bundle singleton', () => {
	// Core is a window-global singleton so separate bundles share ONE graph.
	test( 'the exported Core IS the window-global singleton', () => {
		expect( window.__newspackNodesCore ).toBe( Core );
	} );

	test( "a second bundle's import resolves to the same Core instance", () => {
		jest.resetModules();
		const { Core: reimported } = require( '../core' );
		expect( reimported ).toBe( Core );
	} );
} );

test( 'stderr routes the formatted line to a registered _output sink', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const captured = [];
	Core.registerNode( '_output', { fill: ( m ) => captured.push( m ) } );
	Core.stderr( 'hello sink' );
	expect( captured ).toHaveLength( 1 );
	expect( captured[ 0 ][ TYPE ] ).toBe( TM_BYTESTREAM );
	expect( captured[ 0 ][ VALUE ] ).toMatch( /hello sink/ );
	spy.mockRestore();
} );

test( 'stderr prefers a _repl sink over _output', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	const repl = [];
	const out = [];
	Core.registerNode( '_repl', { fill: ( m ) => repl.push( m ) } );
	Core.registerNode( '_output', { fill: ( m ) => out.push( m ) } );
	Core.stderr( 'only repl' );
	expect( repl ).toHaveLength( 1 );
	expect( out ).toHaveLength( 0 );
	spy.mockRestore();
} );

test( 'registerNode and node lookup', () => {
	const obj = { name: 'x' };
	Core.registerNode( 'x', obj );
	expect( Core.node( 'x' ) ).toBe( obj );
	expect( Core.node( 'missing' ) ).toBeNull();
} );

test( 'registerNode throws on name collision', () => {
	Core.registerNode( 'x', { a: 1 } );
	expect( () => Core.registerNode( 'x', { b: 2 } ) ).toThrow(
		/node name collision/
	);
} );

test( 'unregisterNode removes from registry', () => {
	const obj = { name: 'x' };
	Core.registerNode( 'x', obj );
	Core.unregisterNode( 'x' );
	expect( Core.node( 'x' ) ).toBeNull();
} );

test( 'msgCounter is monotonically increasing', () => {
	const a = Core.msgCounter();
	const b = Core.msgCounter();
	expect( b ).toBeGreaterThan( a );
} );

test( 'now() returns a numeric timestamp in seconds', () => {
	const t = Core.now();
	expect( typeof t ).toBe( 'number' );
	expect( t ).toBeGreaterThan( 1_000_000_000 );
} );

test( 'stderr forwards a prefixed line to console.warn', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.stderr( 'hello' );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	expect( spy.mock.calls[ 0 ][ 0 ] ).toMatch(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+ browser: hello$/
	);
	spy.mockRestore();
} );

test( 'log_prefix prepends a timestamp + identity to every line, with a trailing newline', () => {
	const out = Core.log_prefix( 'a\nb' );
	const lines = out.replace( /\n$/, '' ).split( '\n' );
	expect( lines[ 0 ] ).toMatch(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+ browser: a$/
	);
	expect( lines[ 1 ] ).toMatch(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+ browser: b$/
	);
	expect( out.endsWith( '\n' ) ).toBe( true );
} );

// Tachikoma Node.pm:459 stamps `strftime( '%F %T %Z', localtime )` — the
// reader's own clock, not UTC. The expectations come from Date's local
// getters, a different path from the Intl formatter the prefix is built with,
// so a revert to toISOString() fails anywhere but a UTC host.
describe( 'log_prefix stamps local time with the zone abbreviation', () => {
	const pad = ( n ) => String( n ).padStart( 2, '0' );
	const localOf = ( seconds ) => {
		const d = new Date( seconds * 1000 );
		return (
			`${ d.getFullYear() }-${ pad( d.getMonth() + 1 ) }-` +
			`${ pad( d.getDate() ) } ${ pad( d.getHours() ) }:` +
			`${ pad( d.getMinutes() ) }:${ pad( d.getSeconds() ) }`
		);
	};
	// 2026-01-01 00:00:00 UTC and 2026-06-20 19:00:00 UTC: a winter and a
	// summer instant, so a zone with daylight time is exercised both ways.
	const WINTER = 1767225600;
	const SUMMER = 1782000000;

	test( 'an explicit instant stamps that moment, not now', () => {
		expect( Core.log_prefix( 'winter', WINTER ) ).toBe(
			`${ localOf( WINTER ) } ${ zoneAt( WINTER ) } browser: winter\n`
		);
	} );

	test( 'the same holds across the daylight boundary', () => {
		expect( Core.log_prefix( 'summer', SUMMER ) ).toBe(
			`${ localOf( SUMMER ) } ${ zoneAt( SUMMER ) } browser: summer\n`
		);
	} );

	test( 'log_prefixed leaves a line that already carries one alone', () => {
		expect(
			Core.log_prefixed( '2026-01-02 03:04:05 UTC host proc[7]: already' )
		).toBe( '2026-01-02 03:04:05 UTC host proc[7]: already\n' );
	} );

	test( 'log_prefixed stamps a bare line at the instant given', () => {
		expect( Core.log_prefixed( 'bare', WINTER ) ).toBe(
			`${ localOf( WINTER ) } ${ zoneAt( WINTER ) } browser: bare\n`
		);
	} );
} );

// The zone abbreviation for an instant, read off a formatter asking for
// nothing else — the one part Date's own getters cannot produce.
function zoneAt( seconds ) {
	return new Intl.DateTimeFormat( 'en-CA', { timeZoneName: 'short' } )
		.formatToParts( new Date( seconds * 1000 ) )
		.find( ( { type } ) => 'timeZoneName' === type ).value;
}

test( 'stderr passes an already-date-prefixed line through verbatim (no double prefix)', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.reset();
	Core.stderr( '2026-01-02 03:04:05 UTC host proc[7]: already' );
	expect( Core.recentLog[ 0 ] ).toBe(
		'2026-01-02 03:04:05 UTC host proc[7]: already\n'
	);
	spy.mockRestore();
} );

test( 'printLessOften rate-limits identical messages and routes via stderr', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	for ( let i = 0; i < 20; i++ ) {
		Core.printLessOften( 'repeat me' );
	}
	expect( spy ).toHaveBeenCalledTimes( 1 );
	spy.mockRestore();
} );

// Mirrors PHP Core::print_less_often( string $text, string ...$extra ).
test( 'printLessOften keys on the first arg only; extra prints but never keys', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.printLessOften( 'WARNING: sink refused - ', 'payload: zulu' );
	Core.printLessOften( 'WARNING: sink refused - ', 'payload: yankee' );
	expect( spy ).toHaveBeenCalledTimes( 1 );
	expect( Core.recentLog[ 0 ] ).toContain(
		'WARNING: sink refused - payload: zulu'
	);
	spy.mockRestore();
} );

test( 'recentLog is an array that reset() clears', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	expect( Array.isArray( Core.recentLog ) ).toBe( true );
	expect( Core.recentLog ).toHaveLength( 0 );
	Core.stderr( 'a line' );
	expect( Core.recentLog.length ).toBeGreaterThan( 0 );
	Core.reset();
	expect( Core.recentLog ).toHaveLength( 0 );
	spy.mockRestore();
} );

test( 'stderr appends a prefixed, newline-terminated line per call (dmesg is line-separated)', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.reset();
	Core.stderr( 'first' );
	Core.stderr( 'second' );
	expect( Core.recentLog ).toHaveLength( 2 );
	expect( Core.recentLog[ 0 ] ).toMatch( /: first\n$/ );
	expect( Core.recentLog[ 1 ] ).toMatch( /: second\n$/ );
	// dmesg = recentLog.join('') — newline-separated lines, not "firstsecond".
	expect( Core.recentLog.join( '' ) ).toMatch( /: first\n.+: second\n$/ );
	spy.mockRestore();
} );

test( 'recentLog is bounded to the last 100 lines', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.reset();
	for ( let i = 0; i < 150; i++ ) {
		Core.stderr( `line ${ i }` );
	}
	expect( Core.recentLog ).toHaveLength( 100 );
	expect( Core.recentLog[ 0 ] ).toMatch( /: line 50\n$/ );
	expect( Core.recentLog[ 99 ] ).toMatch( /: line 149\n$/ );
	spy.mockRestore();
} );

test( 'initTime is a number set at construction and re-set by reset()', () => {
	expect( typeof Core.initTime ).toBe( 'number' );
	const nowSpy = jest.spyOn( Core, 'now' ).mockReturnValue( 5_000 );
	Core.reset();
	expect( Core.initTime ).toBe( 5_000 );
	nowSpy.mockRestore();
} );

describe( 'graphGeneration — full-rebuild signal', () => {
	test( 'starts at 0 and bumpGraphGeneration increments it', () => {
		expect( Core.graphGeneration ).toBe( 0 );
		Core.bumpGraphGeneration();
		expect( Core.graphGeneration ).toBe( 1 );
		Core.bumpGraphGeneration();
		expect( Core.graphGeneration ).toBe( 2 );
	} );

	test( 'notifies subscribers on every bump; unsubscribe stops them', () => {
		let calls = 0;
		const unsub = Core.subscribeGraphGeneration( () => {
			calls += 1;
		} );
		Core.bumpGraphGeneration();
		Core.bumpGraphGeneration();
		expect( calls ).toBe( 2 );
		unsub();
		Core.bumpGraphGeneration();
		expect( calls ).toBe( 2 );
	} );

	test( 'reset() returns the generation to 0 and drops subscribers', () => {
		let calls = 0;
		Core.subscribeGraphGeneration( () => {
			calls += 1;
		} );
		Core.bumpGraphGeneration();
		Core.reset();
		expect( Core.graphGeneration ).toBe( 0 );
		Core.bumpGraphGeneration();
		expect( calls ).toBe( 1 ); // pre-reset bump only; post-reset has none
	} );
} );

// A Router is never removed — it is the page's one heartbeat — so a reset that
// only swapped the registry left it ticking against nothing, and a test file
// accumulated one orphaned heartbeat per test until the run ran out of memory.
describe( 'Core.reset', () => {
	it( 'stops the timers of the nodes it discards', () => {
		const { TimerNode } = require( '../timer-node' );
		// Sub-second, so it owns its slot rather than hitchhiking a Router.
		const timer = new TimerNode();
		timer.name = 'wombat:timer-4471';
		timer.setTimer( 250 );
		expect( timer.mode ).not.toBe( 'inactive' );

		Core.reset();

		expect( timer.mode ).toBe( 'inactive' );
	} );
} );

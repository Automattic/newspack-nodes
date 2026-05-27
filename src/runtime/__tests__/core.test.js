import { Core } from '../core';

beforeEach( () => Core.reset() );

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
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC newspack-nodes: hello$/
	);
	spy.mockRestore();
} );

test( 'log_midfix is the empty Core tag: null → "", message → chomped + one newline', () => {
	expect( Core.log_midfix() ).toBe( '' );
	expect( Core.log_midfix( 'x' ) ).toBe( 'x\n' );
	expect( Core.log_midfix( 'x\n\n' ) ).toBe( 'x\n' );
} );

test( 'log_prefix prepends a UTC timestamp + identity to every line, with a trailing newline', () => {
	const out = Core.log_prefix( 'a\nb' );
	const lines = out.replace( /\n$/, '' ).split( '\n' );
	expect( lines[ 0 ] ).toMatch(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC newspack-nodes: a$/
	);
	expect( lines[ 1 ] ).toMatch(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC newspack-nodes: b$/
	);
	expect( out.endsWith( '\n' ) ).toBe( true );
} );

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

test( 'printLeastOften prints only after threshold count, routes via stderr', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	for ( let i = 0; i < 9; i++ ) {
		Core.printLeastOften( 'rare' );
	}
	expect( spy ).not.toHaveBeenCalled();
	Core.printLeastOften( 'rare' );
	expect( spy ).toHaveBeenCalledTimes( 1 );
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

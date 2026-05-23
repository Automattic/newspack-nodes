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

test( 'stderr forwards to console.warn', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.stderr( 'hello' );
	expect( spy ).toHaveBeenCalledWith( 'hello' );
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

test( 'stderr appends each emitted line to recentLog', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	Core.stderr( 'first' );
	Core.stderr( 'second' );
	expect( Core.recentLog ).toEqual( [ 'first', 'second' ] );
	spy.mockRestore();
} );

test( 'recentLog is bounded to the last 100 lines', () => {
	const spy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	for ( let i = 0; i < 150; i++ ) {
		Core.stderr( `line ${ i }` );
	}
	expect( Core.recentLog ).toHaveLength( 100 );
	expect( Core.recentLog[ 0 ] ).toBe( 'line 50' );
	expect( Core.recentLog[ 99 ] ).toBe( 'line 149' );
	spy.mockRestore();
} );

test( 'initTime is a number set at construction and re-set by reset()', () => {
	expect( typeof Core.initTime ).toBe( 'number' );
	const nowSpy = jest.spyOn( Core, 'now' ).mockReturnValue( 5_000 );
	Core.reset();
	expect( Core.initTime ).toBe( 5_000 );
	nowSpy.mockRestore();
} );

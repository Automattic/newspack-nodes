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

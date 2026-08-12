/**
 * StdoutNode — the browser's bare terminal sink, port of PHP `Stdout_Node`.
 * `fill()` coerces the VALUE like PHP's `(string)` cast and hands it to the
 * `write()` seam, which a terminal-aware subclass overrides (as TTY_Out does).
 */

import { StdoutNode } from '../stdout-node';
import { newMessage, TYPE, VALUE, TM_BYTESTREAM } from '../message';

// A message carrying `value`, whatever its type.
function msg( value ) {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = value;
	return m;
}

function makeStdout() {
	const written = [];
	const node = new StdoutNode( { write: ( text ) => written.push( text ) } );
	return { node, written };
}

describe( 'StdoutNode', () => {
	it( 'writes a string VALUE through to its stream verbatim', () => {
		const { node, written } = makeStdout();
		node.fill( msg( 'hello\n' ) );
		expect( written ).toEqual( [ 'hello\n' ] );
	} );

	it( 'counts each fill on the base Node counter', () => {
		const { node } = makeStdout();
		node.fill( msg( 'a' ) );
		node.fill( msg( 'b' ) );
		expect( node.counter ).toBe( 2 );
	} );

	it( 'coerces a null VALUE to the empty string, as PHP casts it', () => {
		const { node, written } = makeStdout();
		node.fill( msg( null ) );
		expect( written ).toEqual( [ '' ] );
	} );

	it( 'coerces an array VALUE to `Array`, as PHP casts it', () => {
		const { node, written } = makeStdout();
		node.fill( msg( [ 'a', 'b' ] ) );
		expect( written ).toEqual( [ 'Array' ] );
	} );

	it( 'coerces a numeric VALUE to its string form', () => {
		const { node, written } = makeStdout();
		node.fill( msg( 42 ) );
		expect( written ).toEqual( [ '42' ] );
	} );

	it( 'renders an object VALUE through its toString', () => {
		const { node, written } = makeStdout();
		node.fill( msg( { toString: () => 'stringable' } ) );
		expect( written ).toEqual( [ 'stringable' ] );
	} );

	it( 'is a no-op with no stream, rather than throwing', () => {
		const node = new StdoutNode();
		expect( () => node.fill( msg( 'x' ) ) ).not.toThrow();
	} );

	it( 'routes through the write() seam, so a subclass can render', () => {
		const seen = [];
		class TtyLike extends StdoutNode {
			write( text ) {
				seen.push( `[${ text }]` );
			}
		}
		new TtyLike().fill( msg( 'prompt' ) );
		expect( seen ).toEqual( [ '[prompt]' ] );
	} );
} );

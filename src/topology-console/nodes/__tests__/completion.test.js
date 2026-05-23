/**
 * Completion node tests — the `_completion` node. `_router` delivers the
 * `help`/`ls` completion reply (KEY='completion') here; the node splits the
 * bare newline-separated candidate payload into an array and publishes it as
 * `{ candidates, seq }` ( useNodeState( '_completion', 'candidates' ) ). The
 * seq increments on every fill so an identical candidate list still notifies.
 * Never touches the transcript.
 */

import { Completion, longestCommonPrefix } from '../completion';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';

function msg( type, value, key = 'completion' ) {
	const m = newMessage();
	m[ TYPE ] = type;
	m[ KEY ] = key;
	m[ VALUE ] = value;
	return m;
}

describe( 'longestCommonPrefix', () => {
	it( 'returns the single string for a one-element list', () => {
		expect( longestCommonPrefix( [ 'dump_node' ] ) ).toBe( 'dump_node' );
	} );

	it( 'returns the common prefix of several strings', () => {
		expect(
			longestCommonPrefix( [
				'connect_node',
				'connect',
				'connect_worker',
			] )
		).toBe( 'connect' );
	} );

	it( 'returns empty when there is no shared prefix', () => {
		expect( longestCommonPrefix( [ 'abc', 'xyz' ] ) ).toBe( '' );
	} );

	it( 'returns empty for an empty list', () => {
		expect( longestCommonPrefix( [] ) ).toBe( '' );
	} );

	it( 'stops at the shortest string', () => {
		expect( longestCommonPrefix( [ 'ab', 'abc', 'abcd' ] ) ).toBe( 'ab' );
	} );
} );

describe( 'Completion node', () => {
	it( 'splits a newline-separated payload into a candidates array', () => {
		const node = new Completion();
		node.fill(
			// eslint-disable-next-line no-bitwise
			msg( TM_COMMAND | TM_RESPONSE, {
				name: 'help',
				payload: 'connect\nconnect_node\ndump_node',
			} )
		);
		const state = node.setStateCache.candidates;
		expect( state.candidates ).toEqual( [
			'connect',
			'connect_node',
			'dump_node',
		] );
	} );

	it( 'accepts a bare string VALUE (no envelope)', () => {
		const node = new Completion();
		node.fill( msg( TM_BYTESTREAM, 'echo\nping' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [
			'echo',
			'ping',
		] );
	} );

	it( 'trims blank lines out of the candidate list', () => {
		const node = new Completion();
		node.fill( msg( TM_BYTESTREAM, 'a\n\n  \nb\n' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [
			'a',
			'b',
		] );
	} );

	it( 'increments seq so an identical candidate list still notifies', () => {
		const node = new Completion();
		node.fill( msg( TM_BYTESTREAM, 'a\nb' ) );
		const first = node.setStateCache.candidates.seq;
		node.fill( msg( TM_BYTESTREAM, 'a\nb' ) );
		const second = node.setStateCache.candidates.seq;
		expect( second ).toBeGreaterThan( first );
	} );

	it( 'publishes an empty candidates array for an empty payload', () => {
		const node = new Completion();
		node.fill( msg( TM_BYTESTREAM, '' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [] );
	} );

	it( 'pre-declares the `candidates` event so useNodeState can subscribe', () => {
		const node = new Completion();
		expect( node.registrations.candidates ).toBeDefined();
	} );

	it( 'works as a real sink target (router → completion.fill)', () => {
		const node = new Completion();
		const router = new Node();
		router.sink = node;
		router.fill( msg( TM_BYTESTREAM, 'one\ntwo' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [
			'one',
			'two',
		] );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const node = new Completion();
		node.fill( msg( TM_BYTESTREAM, 'a' ) );
		node.fill( msg( TM_BYTESTREAM, 'b' ) );
		expect( node.counter ).toBe( 2 );
	} );
} );

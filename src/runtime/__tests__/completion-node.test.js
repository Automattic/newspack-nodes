/**
 * Completion node tests — the `_completion` node. `_router` delivers the
 * `help`/`ls` completion reply (KEY='completion') here; the node splits the
 * bare newline-separated candidate payload into an array and publishes it as
 * `{ candidates, seq }` ( useNodeState( '_completion', 'candidates' ) ). The
 * seq increments on every fill so an identical candidate list still notifies.
 * Never touches the transcript.
 */

import {
	CompletionNode,
	longestCommonPrefix,
	tabulateCandidates,
} from '../completion-node';
import { Node } from '../node';
import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

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
		const node = new CompletionNode();
		node.fill(
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
		const node = new CompletionNode();
		node.fill( msg( TM_BYTESTREAM, 'echo\nping' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [
			'echo',
			'ping',
		] );
	} );

	it( 'trims blank lines out of the candidate list', () => {
		const node = new CompletionNode();
		node.fill( msg( TM_BYTESTREAM, 'a\n\n  \nb\n' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [
			'a',
			'b',
		] );
	} );

	it( 'increments seq so an identical candidate list still notifies', () => {
		const node = new CompletionNode();
		node.fill( msg( TM_BYTESTREAM, 'a\nb' ) );
		const first = node.setStateCache.candidates.seq;
		node.fill( msg( TM_BYTESTREAM, 'a\nb' ) );
		const second = node.setStateCache.candidates.seq;
		expect( second ).toBeGreaterThan( first );
	} );

	it( 'publishes an empty candidates array for an empty payload', () => {
		const node = new CompletionNode();
		node.fill( msg( TM_BYTESTREAM, '' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [] );
	} );

	it( 'pre-declares the `candidates` event so useNodeState can subscribe', () => {
		const node = new CompletionNode();
		expect( node.registrations.candidates ).toBeDefined();
	} );

	it( 'works as a real sink target (router → completion.fill)', () => {
		const node = new CompletionNode();
		const router = new Node();
		router.sink = node;
		router.fill( msg( TM_BYTESTREAM, 'one\ntwo' ) );
		expect( node.setStateCache.candidates.candidates ).toEqual( [
			'one',
			'two',
		] );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const node = new CompletionNode();
		node.fill( msg( TM_BYTESTREAM, 'a' ) );
		node.fill( msg( TM_BYTESTREAM, 'b' ) );
		expect( node.counter ).toBe( 2 );
	} );

	it( 'declares has_target:false (publishes candidates, never forwards)', () => {
		expect( CompletionNode.nodeSchema().has_target ).toBe( false );
	} );
} );

describe( 'tabulateCandidates', () => {
	it( 'returns an empty string for no candidates', () => {
		expect( tabulateCandidates( [] ) ).toBe( '' );
		expect( tabulateCandidates( null ) ).toBe( '' );
	} );

	it( 'pads each candidate to the longest width so columns align', () => {
		// Longest is `make_node` (9); each column starts at a multiple of
		// width + a 2-space gap (= 11), so the transcript reflows into an
		// aligned grid instead of wrapping mid-word.
		const out = tabulateCandidates( [ 'ls', 'make_node', 'rm' ] );
		expect( out.indexOf( 'make_node' ) ).toBe( 11 );
		expect( out.indexOf( 'rm' ) ).toBe( 22 );
	} );

	it( 'leaves no trailing padding after the last candidate', () => {
		expect(
			/\s$/.test( tabulateCandidates( [ 'ls', 'make_node', 'rm' ] ) )
		).toBe( false );
	} );
} );

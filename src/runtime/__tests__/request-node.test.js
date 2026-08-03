/**
 * RequestNode — mints one command, resolves when its reply routes back.
 *
 * The point of the node is that there is nothing to correlate: it carries one
 * in-flight command, so the reply addressed to it IS that command's answer. No
 * op-id, no KEY, no Map keyed by either.
 */

import { RequestNode } from '../request-node';
import { Core } from '../core';
import { forgetSession, __setAuthFetch } from '../command-auth';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../message';

// Distinct from every default so a wrong-field read fails rather than coincides.
const PAYLOAD = { topologies: [ 'combined' ] };
const REASON = 'topology "combined" is stock; copy it first';
const SECOND = { name: 'combined', tsl: 'make_node Echo e' };

const waitFor = async ( assert ) => {
	for ( let i = 0; i < 50; i++ ) {
		try {
			assert();
			return;
		} catch ( e ) {
			await new Promise( ( r ) => setTimeout( r, 10 ) );
		}
	}
	assert();
};

const makeNode = ( name = 'topologies:req' ) => {
	const sent = [];
	const node = new RequestNode();
	node.name = name;
	node.target = '_http/topologies';
	node.sink = { fill: ( m ) => sent.push( m ) };
	return { node, sent };
};

const reply = ( kind, payload ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | kind;
	m[ VALUE ] = { name: 'list', payload };
	return m;
};

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

test( 'mints FROM itself, addressed at its target, with no ID or KEY', () => {
	const { node, sent } = makeNode();

	node.request( 'list', [] );

	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ FROM ] ).toBe( 'topologies:req' );
	expect( sent[ 0 ][ TO ] ).toBe( '_http/topologies' );
	expect( sent[ 0 ][ VALUE ].name ).toBe( 'list' );
	// The whole point: addressing is the correlation.
	expect( sent[ 0 ][ ID ] ).toBe( '' );
	expect( sent[ 0 ][ KEY ] ).toBe( '' );
} );

test( 'resolves with the reply payload', async () => {
	const { node } = makeNode();

	const pending = node.request( 'list', [] );
	node.fill( reply( TM_RESPONSE, PAYLOAD ) );

	await expect( pending ).resolves.toEqual( PAYLOAD );
} );

test( 'rejects a TM_ERROR with its message', async () => {
	const { node } = makeNode();

	const pending = node.request( 'delete', [ 'combined' ] );
	node.fill( reply( TM_ERROR, REASON ) );

	await expect( pending ).rejects.toThrow( REASON );
} );

test( 'a TM_ERROR rejection is marked as having come from the server', async () => {
	// A caller that retries needs to tell "the server says no" from "no
	// answer yet" — the first is final, and retrying it never terminates.
	const { node } = makeNode();

	const pending = node.request( 'delete', [ 'combined' ] );
	node.fill( reply( TM_ERROR, REASON ) );

	await expect( pending ).rejects.toMatchObject( { fromServer: true } );
} );

test( 'an unmounted-node rejection is NOT marked as from the server', async () => {
	const { node } = makeNode();

	const pending = node.request( 'list', [] );
	node.removeNode();

	const err = await pending.catch( ( e ) => e );

	expect( err.message ).toMatch( /was removed/ );
	expect( err.fromServer ).toBeUndefined();
} );

test( 'serializes a second request behind the first', async () => {
	const { node, sent } = makeNode();

	const first = node.request( 'list', [] );
	const second = node.request( 'get', [ 'combined' ] );

	// One command on the wire: the second is held, not minted.
	expect( sent ).toHaveLength( 1 );
	expect( sent[ 0 ][ VALUE ].name ).toBe( 'list' );

	node.fill( reply( TM_RESPONSE, PAYLOAD ) );
	await expect( first ).resolves.toEqual( PAYLOAD );

	// Now — and only now — the queued one goes out.
	expect( sent ).toHaveLength( 2 );
	expect( sent[ 1 ][ VALUE ].name ).toBe( 'get' );
	node.fill( reply( TM_RESPONSE, SECOND ) );
	await expect( second ).resolves.toEqual( SECOND );
} );

test( 'a queued request is rejected, not stranded, when the node goes', async () => {
	const { node } = makeNode();

	const first = node.request( 'list', [] );
	const second = node.request( 'get', [ 'combined' ] );
	// Handlers attached before the rejection, so neither is unhandled.
	const firstSettled = first.catch( ( e ) => e );
	const secondSettled = second.catch( ( e ) => e );
	node.removeNode();

	expect( ( await firstSettled ).message ).toMatch( /was removed/ );
	expect( ( await secondSettled ).message ).toMatch( /was removed/ );
} );

test( 'is reusable once settled', async () => {
	const { node, sent } = makeNode();

	const first = node.request( 'list', [] );
	node.fill( reply( TM_RESPONSE, PAYLOAD ) );
	await first;

	const second = node.request( 'list', [] );
	node.fill( reply( TM_RESPONSE, PAYLOAD ) );

	await expect( second ).resolves.toEqual( PAYLOAD );
	expect( sent ).toHaveLength( 2 );
} );

test( 'a reply arriving with nothing outstanding is ignored, not thrown', () => {
	const { node } = makeNode();

	expect( () => node.fill( reply( TM_RESPONSE, PAYLOAD ) ) ).not.toThrow();
} );

test( 'removeNode rejects the outstanding request rather than hanging it', async () => {
	const { node } = makeNode();

	const pending = node.request( 'list', [] );
	node.removeNode();

	await expect( pending ).rejects.toThrow( /was removed/ );
} );

test( 'waits for the session rather than refusing a pre-auth mint', async () => {
	// A fresh page: the request is minted while /auth is still in flight.
	forgetSession();
	__setAuthFetch(
		() =>
			new Promise( ( resolve ) =>
				setTimeout(
					() =>
						resolve( {
							handle: 'h-7731',
							key: 'k-7731',
							expires_in: 3600,
						} ),
					20
				)
			)
	);
	const { node, sent } = makeNode();

	const pending = node.request( 'list', [] );
	// Nothing minted yet — but the request is alive, not rejected.
	expect( sent ).toHaveLength( 0 );

	await waitFor( () => expect( sent ).toHaveLength( 1 ) );
	expect( sent[ 0 ][ FROM ] ).toBe( 'topologies:req' );

	node.fill( reply( TM_RESPONSE, PAYLOAD ) );
	await expect( pending ).resolves.toEqual( PAYLOAD );
	__setAuthFetch( null );
	forgetSession();
} );

test( 'a request that never draws a reply times out', async () => {
	jest.useFakeTimers();
	try {
		const { node } = makeNode();
		const pending = node.request( 'list', [] );
		// Attach before advancing, so the rejection is never unhandled.
		const settled = pending.catch( ( e ) => e );
		jest.advanceTimersByTime( 30000 );
		expect( ( await settled ).message ).toMatch( /timed out/ );
	} finally {
		jest.useRealTimers();
	}
} );

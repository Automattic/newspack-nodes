/**
 * useAwaitableCommand — an awaited verb that still rides the batch.
 *
 * Some callers are genuinely sequential: a deep link resolves a request id,
 * then looks up the URL it names, then selects it. Those want to await. What
 * they must NOT do is mint their own POST to get an answer — which is what the
 * Request node did, outside the router's lock/flush bracket.
 *
 * The command rides the tick like every other; the promise is only how the
 * caller waits for the answer that lands on the node that asked.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useAwaitableCommand } from '../useAwaitableCommand';

// Distinct from every default so a wrong-field read fails rather than coincides.
const FOUND = { url_hash: 'h-4471', partition: 3 };

let replyFor;

const renderSearch = () =>
	renderHook( () =>
		useAwaitableCommand( {
			ci: 'performance',
			command: 'request_search',
		} )
	);

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => FOUND );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

it( 'resolves with the reply the tick brought back', async () => {
	const { result } = renderSearch();
	let answer;
	act( () => {
		answer = result.current( [ 'rid-8823' ] );
	} );

	// The reply publishes into React as it settles; waitFor absorbs that
	// render, and the promise is already settled by the time it returns.
	await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
		timeout: 6000,
	} );
	await expect( answer ).resolves.toEqual( FOUND );
	expect( replyFor ).toHaveBeenCalledTimes( 1 );
	expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ].arguments ).toEqual( [
		'rid-8823',
	] );
}, 15000 );

it( 'rejects a refusal, flagged as the server having answered', async () => {
	replyFor.mockImplementation( () => new Error( 'no such request' ) );
	const { result } = renderSearch();
	let answer;
	act( () => {
		answer = result.current( [ 'rid-8823' ] ).catch( ( e ) => e );
	} );

	await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
		timeout: 6000,
	} );
	const err = await answer;
	expect( err.message ).toContain( 'no such request' );
	// A refusal IS an answer; the caller stops holding the intent.
	expect( err.fromServer ).toBe( true );
}, 15000 );

// Two awaits outstanding at once must not cross: the answers come back in the
// order they were sent, and each settles its own promise.
it( 'settles concurrent awaits in order', async () => {
	replyFor.mockImplementation( ( m ) => ( {
		asked: m[ VALUE ].arguments[ 0 ],
	} ) );
	const { result } = renderSearch();
	let first;
	let second;
	act( () => {
		first = result.current( [ 'rid-1' ] );
		second = result.current( [ 'rid-2' ] );
	} );

	await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ), {
		timeout: 8000,
	} );
	await expect( first ).resolves.toEqual( { asked: 'rid-1' } );
	await expect( second ).resolves.toEqual( { asked: 'rid-2' } );
}, 20000 );

it( 'sends nothing until it is called', async () => {
	renderSearch();
	await act( async () => {
		await new Promise( ( r ) => setTimeout( r, 1200 ) );
	} );
	expect( replyFor ).not.toHaveBeenCalled();
}, 15000 );

it( 'rejects everything outstanding when the graph goes away', async () => {
	replyFor.mockImplementation( () => new Promise( () => {} ) );
	const { result, unmount } = renderSearch();
	let outcome;
	act( () => {
		outcome = result.current( [ 'rid-8823' ] ).catch( ( e ) => e );
	} );
	await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ), {
		timeout: 6000,
	} );

	act( () => unmount() );

	const err = await outcome;
	expect( err.message ).toMatch( /graph/i );
}, 15000 );

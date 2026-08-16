/**
 * useSessionsGraph — the issued-session TABLE.
 *
 *   sessions:list:in (Tee) → sessions:list:view (SessionListView)
 *
 * ONE node per verb serves every row: the subject rides in the reply PATH, so
 * an answer names the handle it was about. The hook owns the poll — which is
 * also the retry, so a refused tick keeps what is on screen — and re-lists as
 * soon as a mutation answers.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core, FROM, VALUE } from '@newspack-nodes/runtime';
import { useSessionsGraph } from '../useSessionsGraph';

// Distinct from every default so a wrong-field read fails rather than coincides.
const LISTING = {
	sessions: [ { handle: 'h-4471', label: 'hub-aggregator', scope: 'read' } ],
	scopes: [ 'read', 'tune', 'manage' ],
	ttl_max: 4471,
};

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

it( 'lists on the first tick and publishes the table', async () => {
	const wire = installFakeCommandWire( () => LISTING );
	const { result } = renderHook( () => useSessionsGraph() );

	await waitFor( () => expect( result.current.sessions ).not.toBeNull(), {
		timeout: 6000,
	} );
	expect( result.current.sessions ).toEqual( LISTING.sessions );
	expect( result.current.scopes ).toEqual( LISTING.scopes );
	expect( result.current.ttlMax ).toBe( 4471 );
	expect(
		wire.batches.flat().some( ( m ) => 'list' === m[ VALUE ]?.name )
	).toBe( true );
}, 20000 );

// @longform ONE node per verb serves every row: a revoke of `h-4471` is minted
// FROM `sessions:revoke:in/h-4471`, the server echoes TO = FROM, the Router
// peels the receiver off, and the answer arrives naming the handle. No id in
// the message, no table, and no node per row.
it( 'names the handle each revoke answered, from the reply path', async () => {
	const answers = [];
	const wire = installFakeCommandWire( () => LISTING );
	const { result } = renderHook( () =>
		useSessionsGraph( { onAnswer: ( a ) => answers.push( a ) } )
	);
	await act( async () => {} );

	act( () => {
		result.current.revokeSession( 'h-4471' );
		result.current.revokeSession( 'h-8823' );
	} );

	await waitFor( () => expect( answers.length ).toBe( 2 ), {
		timeout: 8000,
	} );
	expect( answers.map( ( a ) => a.subject ).sort() ).toEqual( [
		'h-4471',
		'h-8823',
	] );
	expect(
		wire.batches
			.flat()
			.filter( ( m ) => 'revoke' === m[ VALUE ]?.name )
			.map( ( m ) => m[ FROM ] )
	).toEqual( [ 'sessions:revoke:in/h-4471', 'sessions:revoke:in/h-8823' ] );
}, 30000 );

// A revoke changes the table, so the answer re-lists rather than leaving the
// row on screen until the cadence next comes round.
it( 'lists again as soon as a revoke answers, ahead of the cadence', async () => {
	const wire = installFakeCommandWire( () => LISTING );
	const { result } = renderHook( () => useSessionsGraph() );
	await waitFor( () => expect( result.current.sessions ).not.toBeNull(), {
		timeout: 6000,
	} );
	const listed = () =>
		wire.batches.flat().filter( ( m ) => 'list' === m[ VALUE ]?.name )
			.length;
	const before = listed();

	act( () => result.current.revokeSession( 'h-4471' ) );

	// Under the 5s list cadence, so only the answer can explain a fresh list.
	await waitFor( () => expect( listed() ).toBeGreaterThan( before ), {
		timeout: 4000,
	} );
}, 30000 );

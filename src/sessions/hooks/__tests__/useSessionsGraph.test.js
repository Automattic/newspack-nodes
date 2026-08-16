/**
 * useSessionsGraph — the issued-session TABLE.
 *
 *   sessions:list:in (Tee) → sessions:list:view (SessionListView)
 *
 * The verbs are not here: a row's Revoke and the form's Create each belong to
 * the surface that sends them, scoped to the session they are about, and are
 * covered in `SessionsAdmin.test.js`. What this hook owns is the poll — which
 * is also the retry, so a refused tick keeps what is on screen.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core, VALUE } from '@newspack-nodes/runtime';
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

it( 'hands back the table and its refresh, and no verbs', async () => {
	installFakeCommandWire( () => LISTING );
	const { result } = renderHook( () => useSessionsGraph() );
	await act( async () => {} );

	expect( Object.keys( result.current ).sort() ).toEqual( [
		'error',
		'loading',
		'refresh',
		'scopes',
		'sessions',
		'ttlMax',
	] );
}, 20000 );

/**
 * useSessionsGraph — the command-session admin graph.
 *
 *   sessions:listIn (Tee) → sessions:list (SessionListView)   — the table
 *   sessions:{create,revoke}:in → :result                     — one-shots
 *
 * Nothing correlates. Each verb is minted FROM the node that wants its answer,
 * the reply comes back TO = FROM, and it lands there — so the table refresh and
 * the two verbs are told apart by WHICH NODE they arrive on. Each answer
 * carries the arguments that produced it, which is how a row recognises its
 * own. Both verbs ride the router tick, so a dispatch is a wait, not a flush.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core, ID, KEY, VALUE } from '@newspack-nodes/runtime';
import { formatCommandArgs } from '../../../runtime/command-args';
import { useSessionsGraph } from '../useSessionsGraph';

// Distinct from every default so a wrong-field read fails rather than coincides.
const ISSUED = {
	handle: 'h-4471',
	key: 'k-8823',
	scope: 'read',
	expires_in: 900,
};

let replyFor;

const sent = ( wire, verb ) =>
	wire.batches.flat().find( ( m ) => verb === m[ VALUE ]?.name );

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( ( m ) =>
		'create' === m[ VALUE ].name ? ISSUED : {}
	);
} );

it( 'mints create on the tick with no ID and no KEY, then re-lists', async () => {
	const wire = installFakeCommandWire( ( m ) => replyFor( m ) );
	let issued = null;
	const { result } = renderHook( () =>
		useSessionsGraph( { onIssued: ( session ) => ( issued = session ) } )
	);
	await act( async () => {} );
	const listsBefore = wire.batches
		.flat()
		.filter( ( m ) => 'list' === m[ VALUE ]?.name ).length;

	act( () => {
		result.current.createSession( {
			label: 'hub-aggregator',
			scope: 'read',
			ttl: 900,
		} );
	} );

	await waitFor( () => expect( sent( wire, 'create' ) ).toBeTruthy(), {
		timeout: 6000,
	} );
	const create = sent( wire, 'create' );
	expect( create[ ID ] ).toBe( '' );
	expect( create[ KEY ] ).toBe( '' );
	expect( create[ VALUE ].arguments ).toEqual(
		formatCommandArgs( [ 'hub-aggregator' ], { scope: 'read', ttl: 900 } )
	);

	// The one-time key is HANDED to the caller on the create's own answer —
	// never published, because it is disclosed exactly once.
	await waitFor( () => expect( issued ).toEqual( ISSUED ), {
		timeout: 6000,
	} );
	// The answer itself is filed under the label it was issued for.
	expect( result.current.answerFor( 'hub-aggregator' ) ).toMatchObject( {
		verb: 'create',
		busy: false,
		error: null,
	} );

	// Issuing changes the table, so the answer re-lists.
	await waitFor(
		() =>
			expect(
				wire.batches
					.flat()
					.filter( ( m ) => 'list' === m[ VALUE ]?.name ).length
			).toBeGreaterThan( listsBefore ),
		{ timeout: 6000 }
	);
}, 20000 );

it( 'publishes a refused revoke against the handle it was about', async () => {
	replyFor.mockImplementation( () => new Error( 'no such session' ) );
	const wire = installFakeCommandWire( ( m ) => replyFor( m ) );
	const { result } = renderHook( () => useSessionsGraph() );
	await act( async () => {} );

	act( () => {
		result.current.revokeSession( 'h-4471' );
	} );

	await waitFor( () => expect( sent( wire, 'revoke' ) ).toBeTruthy(), {
		timeout: 6000,
	} );
	await waitFor(
		() =>
			expect( result.current.answerFor( 'h-4471' ) ).toMatchObject( {
				verb: 'revoke',
				busy: false,
			} ),
		{ timeout: 6000 }
	);
	expect( result.current.answerFor( 'h-4471' ).error ).toContain(
		'no such session'
	);
}, 20000 );

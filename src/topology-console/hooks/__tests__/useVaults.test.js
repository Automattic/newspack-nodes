/**
 * useVaults — one `vault.list` round trip on first truthy `enabled`, mapped to
 * the {id,url} option shape the vault_id dropdown consumes.
 *
 * Driven through the real wire: the command is minted by the hook's Request
 * node and the reply comes back addressed to it, so nothing here correlates.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { Core, renewSession, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useVaults } from '../useCatalogs';
import { runClockFast } from '@newspack-nodes/shared/test-utils/fastClock';

// Distinct from every default so a wrong-field read fails rather than coincides.
const LISTED = {
	austin: {
		id: 'austin',
		url: 'https://a.example',
		has_credentials: true,
		is_config: false,
	},
	github: { id: 'github', url: '', has_credentials: true, is_config: false },
};

let replyFor;

beforeEach( () => {
	Core.reset();
	runClockFast();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => LISTED );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

describe( 'useVaults', () => {
	// The `fetched` latch was set BEFORE the request, so one failure blocked
	// the vault list for the life of the page.
	it( 're-establishes the vault list after an auth invalidation', async () => {
		replyFor.mockImplementationOnce( () => new Error( 'refused-9931' ) );

		const { result } = renderHook( () => useVaults( { enabled: true } ) );
		await waitFor( () => expect( result.current.error ).toBeTruthy() );
		expect( result.current.vaults ).toEqual( [] );

		act( () => {
			renewSession();
		} );

		// The generation change is noticed on the reconcile tick (1s), then
		// the round trip runs — past waitFor's 1s default.
		await waitFor(
			() =>
				expect( result.current.vaults ).toEqual( [
					{ id: 'austin', url: 'https://a.example' },
					{ id: 'github', url: '' },
				] ),
			{ timeout: 4000 }
		);
	} );

	it( 'maps the id-keyed vault.list reply to [{id,url}]', async () => {
		const { result } = renderHook( () => useVaults( { enabled: true } ) );
		await waitFor( () => expect( result.current.vaults.length ).toBe( 2 ) );

		expect( result.current.vaults ).toEqual( [
			{ id: 'austin', url: 'https://a.example' },
			{ id: 'github', url: '' },
		] );
		const sent = replyFor.mock.calls[ 0 ][ 0 ];
		expect( sent[ VALUE ].name ).toBe( 'list' );
	} );

	it( 'does not fetch when disabled', () => {
		renderHook( () => useVaults( { enabled: false } ) );
		expect( replyFor ).not.toHaveBeenCalled();
	} );
} );

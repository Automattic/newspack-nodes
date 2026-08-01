/**
 * useVaults — one `vault.list` call on first truthy `enabled`, mapped to
 * the {id,url} option shape the vault_id dropdown consumes.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { renewSession } from '@newspack-nodes/runtime';

const mockSend = jest.fn();
jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: () => ( { send: mockSend } ),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => ( {
	__esModule: true,
	default: ( m ) => m,
} ) );

import { useVaults } from '../useVaults';

beforeEach( () => mockSend.mockReset() );

describe( 'useVaults', () => {
	// fetched.current was set BEFORE the request, so one failure blocked the
	// vault list for the life of the page.
	it( 're-establishes the vault list after an auth invalidation', async () => {
		mockSend
			.mockRejectedValueOnce( new Error( 'refused-9931' ) )
			.mockResolvedValue( {
				eve: { id: 'eve', url: 'https://e.example' },
			} );

		const { result } = renderHook( () => useVaults( { enabled: true } ) );
		await waitFor( () => expect( result.current.error ).toBeTruthy() );
		expect( result.current.vaults ).toEqual( [] );

		act( () => {
			renewSession();
		} );

		await waitFor( () =>
			expect( result.current.vaults ).toEqual( [
				{ id: 'eve', url: 'https://e.example' },
			] )
		);
	} );

	it( 'maps the id-keyed vault.list reply to [{id,url}]', async () => {
		mockSend.mockResolvedValue( {
			austin: {
				id: 'austin',
				url: 'https://a.example',
				has_credentials: true,
				is_config: false,
			},
			github: {
				id: 'github',
				url: '',
				has_credentials: true,
				is_config: false,
			},
		} );
		const { result } = renderHook( () => useVaults( { enabled: true } ) );
		await waitFor( () => expect( result.current.vaults.length ).toBe( 2 ) );
		expect( result.current.vaults ).toEqual( [
			{ id: 'austin', url: 'https://a.example' },
			{ id: 'github', url: '' },
		] );
		expect( mockSend ).toHaveBeenCalledWith( {
			to: 'vault',
			verb: 'list',
		} );
	} );

	it( 'does not fetch when disabled', () => {
		renderHook( () => useVaults( { enabled: false } ) );
		expect( mockSend ).not.toHaveBeenCalled();
	} );
} );

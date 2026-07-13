/**
 * Tests for useExpandedIncludes — the composed baseline for the draft's
 * include set (one `topologies expand` round trip per include-set change).
 */

import { renderHook, waitFor } from '@testing-library/react';
import { useExpandedIncludes } from '../useExpandedIncludes';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

// Payload the real unwrapCommandResponse would extract from a Message tuple.
const commandReply = ( payload ) => payload;

describe( 'useExpandedIncludes', () => {
	let send;
	beforeEach( () => {
		send = jest.fn();
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockImplementation( ( message ) => message );
	} );

	it( 'returns an empty baseline and never fetches when there are no includes', async () => {
		const { result } = renderHook( () => useExpandedIncludes( [] ) );
		expect( result.current.baseline ).toEqual( {
			nodes: [],
			edges: [],
			tree: {},
		} );
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'fetches topologies expand for the include set', async () => {
		send.mockResolvedValue(
			commandReply( {
				nodes: [ { name: 'shared-tee' } ],
				edges: [],
				tree: {},
			} )
		);
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'performance', 'job-router' ] )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'expand',
			args: 'performance job-router',
		} );
		expect( result.current.baseline.nodes ).toEqual( [
			{ name: 'shared-tee' },
		] );
	} );

	it( 'surfaces a cycle error and keeps the last-good baseline', async () => {
		send.mockRejectedValue(
			new Error( 'topology include cycle: a -> b -> a' )
		);
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'cycle-a' ] )
		);
		await waitFor( () =>
			expect( result.current.error ).toMatch( /include cycle/ )
		);
		expect( result.current.baseline ).toEqual( {
			nodes: [],
			edges: [],
			tree: {},
		} );
	} );
} );

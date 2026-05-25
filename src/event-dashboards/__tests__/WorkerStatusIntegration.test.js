/**
 * WorkerStatus integration test — the REAL workerstatus graph driving the REAL
 * thin view. Only the I/O boundary is mocked (getCommandClient +
 * unwrapCommandResponse, like the pre-conversion test); the poll, transform, and
 * view nodes plus the hook are all real.
 *
 * This is the regression guard for the useNodeState-after-mount timing: the view
 * node is created in the hook's mount effect (after the first render), and the
 * async poll publishes its model before any React render has subscribed. Unless
 * the hook forces a re-render once the graph is mounted, React never picks up the
 * first model and the dashboard stays stuck on the loading placeholder. Worker
 * Status has no rAF to mask this (unlike Raw Logs), so it must be handled here.
 */

import { render, act } from '@testing-library/react';
import { Core } from '../../runtime/core';

jest.mock( '../../shared/utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../shared/utils/unwrapCommandResponse', () => jest.fn() );
jest.mock( '../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

const { getCommandClient } = require( '../../shared/utils/commandClient' );
const unwrapCommandResponse = require( '../../shared/utils/unwrapCommandResponse' );

import WorkerStatus from '../WorkerStatus';

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
} );

describe( 'WorkerStatus integration (real graph)', () => {
	it( 'leaves the loading gate once the first dump_metadata model is published', async () => {
		const send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockReturnValue( {
			workers: [],
			supervisor: null,
			logs: [],
			segment_size: 1024,
			timestamp: 0,
		} );

		const { container } = render( <WorkerStatus fullPage /> );
		// Let the mount poll resolve and the model flow poll → transform → view.
		await act( async () => {} );

		// The real graph delivered the model to React: no loading placeholder, and
		// the rendered chrome is present.
		expect( container.textContent ).not.toMatch( /Loading worker status/ );
		expect(
			container.querySelector( '.worker-status-header' )
		).not.toBeNull();
		expect( container.querySelector( '.pipeline-flow' ) ).not.toBeNull();
	} );

	it( 'renders worker rows from a real dump_metadata response', async () => {
		const send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockReturnValue( {
			workers: [
				{
					type: 'firehose-workers',
					handler: 'firehose-workers',
					partition: 0,
					started_at: 1000,
					status: 'running',
					inputs: [],
					outputs: [],
					inputs_status: [],
					outputs_status: [],
				},
			],
			supervisor: null,
			logs: [],
		} );

		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Firehose Workers/ );
	} );

	it( 'surfaces a disconnect error when the real poll rejects', async () => {
		const send = jest.fn().mockRejectedValue( new Error( 'boom' ) );
		getCommandClient.mockReturnValue( { send } );

		const { container } = render( <WorkerStatus fullPage /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Server disconnected/ );
	} );
} );

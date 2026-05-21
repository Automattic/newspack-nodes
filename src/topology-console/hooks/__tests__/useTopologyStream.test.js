/**
 * Tests for useTopologyStream — now a thin adapter over the shared
 * `useMessageStream` hook. It subscribes to the worker reader id
 * `{topology}.p{N}`, reads the session pid from the substrate's
 * `connected` envelope, and converts each raw positional Message array
 * into the `{type, ts, from, to, id, key, value}` object shape the
 * TopologyConsole's handleMessage expects.
 *
 * `useMessageStream` is mocked so we can capture its options and drive
 * synthetic envelopes through the adapter deterministically.
 */

import { renderHook, act } from '@testing-library/react';

let lastOptions = null;
let mockError = null;
const mockConnect = jest.fn();
const mockClose = jest.fn();

jest.mock( '../../../shared/hooks/useMessageStream', () => ( {
	__esModule: true,
	default: ( options ) => {
		lastOptions = options;
		return {
			error: mockError,
			connect: mockConnect,
			close: mockClose,
			lastEventTime: null,
		};
	},
} ) );

import { useTopologyStream } from '../useTopologyStream';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_INFO,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';

function connectedEnvelope( pid ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ FROM ] = '_stream';
	m[ KEY ] = 'connected';
	m[ VALUE ] = { pid, slot: 1, subscriptions: [ 'demo.p0' ], interval: 5000 };
	return m;
}

describe( 'useTopologyStream', () => {
	beforeEach( () => {
		lastOptions = null;
		mockError = null;
		mockConnect.mockClear();
		mockClose.mockClear();
	} );

	it( 'subscribes to the worker reader id {topology}.p{N}', () => {
		renderHook( () => useTopologyStream( 'demo', 3, () => {} ) );
		expect( lastOptions.subscriptions ).toEqual( [ 'demo.p3' ] );
	} );

	it( 'starts in connecting status with a null pid', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		expect( result.current.status ).toBe( 'connecting' );
		expect( result.current.ssePid ).toBeNull();
	} );

	it( 'connects on mount when enabled', () => {
		renderHook( () => useTopologyStream( 'demo', 0, () => {} ) );
		expect( mockConnect ).toHaveBeenCalled();
	} );

	it( 'flips to open and captures pid from the connected envelope', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		act( () => {
			lastOptions.onMessage( connectedEnvelope( 12345 ), {
				type: TM_INFO,
			} );
		} );
		expect( result.current.status ).toBe( 'open' );
		expect( result.current.ssePid ).toBe( 12345 );
	} );

	it( 'does not forward the connected envelope to the caller', () => {
		const onMessage = jest.fn();
		renderHook( () => useTopologyStream( 'demo', 0, onMessage ) );
		act( () => {
			lastOptions.onMessage( connectedEnvelope( 7 ), { type: TM_INFO } );
		} );
		expect( onMessage ).not.toHaveBeenCalled();
	} );

	it( 'converts a positional Message array into the object shape', () => {
		// eslint-disable-next-line no-bitwise
		const cmdResponse = TM_COMMAND | TM_RESPONSE;
		const onMessage = jest.fn();
		renderHook( () => useTopologyStream( 'demo', 0, onMessage ) );
		const m = newMessage();
		m[ TYPE ] = cmdResponse;
		m[ TIMESTAMP ] = 1700000000;
		m[ FROM ] = '_command_interpreter';
		m[ TO ] = '_http/99';
		m[ ID ] = '3:128';
		m[ KEY ] = 'gui:auto';
		m[ VALUE ] = { name: 'dump_metadata', payload: '{"nodes":[]}' };
		act( () => {
			lastOptions.onMessage( m, { type: m[ TYPE ] } );
		} );
		expect( onMessage ).toHaveBeenCalledWith( {
			type: cmdResponse,
			ts: 1700000000,
			from: '_command_interpreter',
			to: '_http/99',
			id: '3:128',
			key: 'gui:auto',
			value: { name: 'dump_metadata', payload: '{"nodes":[]}' },
		} );
	} );

	it( 'maps useMessageStream error into error status', () => {
		mockError = 'Reconnecting in 2s...';
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		expect( result.current.status ).toBe( 'error' );
	} );

	it( 'short-circuits (closed, no connect) when enabled=false', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {}, false )
		);
		expect( result.current.status ).toBe( 'closed' );
		expect( result.current.ssePid ).toBeNull();
		expect( mockConnect ).not.toHaveBeenCalled();
	} );

	it( 'closes the connection on unmount', () => {
		const { unmount } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		unmount();
		expect( mockClose ).toHaveBeenCalled();
	} );

	it( 'always uses the latest onMessage closure', () => {
		const first = jest.fn();
		const second = jest.fn();
		const { rerender } = renderHook(
			( { fn } ) => useTopologyStream( 'demo', 0, fn ),
			{ initialProps: { fn: first } }
		);
		rerender( { fn: second } );
		const m = newMessage();
		m[ TYPE ] = 1;
		m[ VALUE ] = 'x';
		act( () => {
			lastOptions.onMessage( m, { type: 1 } );
		} );
		expect( first ).not.toHaveBeenCalled();
		expect( second ).toHaveBeenCalled();
	} );
} );

/**
 * RawLogs UI-surface tests; useMessageStream + getCommandClient are mocked.
 */

import { render, fireEvent, act } from '@testing-library/react';
import RawLogs from '../RawLogs';

jest.mock( '../../shared/utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../shared/utils/unwrapCommandResponse', () => jest.fn() );
jest.mock( '../../shared/hooks/useMessageStream', () => ( {
	__esModule: true,
	default: jest.fn(),
} ) );
jest.mock( '../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

const { getCommandClient } = require( '../../shared/utils/commandClient' );
const unwrapCommandResponse = require( '../../shared/utils/unwrapCommandResponse' );
const useMessageStream =
	require( '../../shared/hooks/useMessageStream' ).default;

const installMessageStreamMock = ( overrides = {} ) => {
	useMessageStream.mockReturnValue( {
		error: null,
		connect: jest.fn(),
		close: jest.fn(),
		lastEventTime: null,
		...overrides,
	} );
};

describe( 'RawLogs', () => {
	let sendMock;
	beforeAll( () => {
		// Stub the Canvas 2D context (jsdom lacks it).
		window.HTMLCanvasElement.prototype.getContext = function () {
			return {
				setTransform: () => {},
				clearRect: () => {},
				fillRect: () => {},
				fillText: () => {},
				measureText: () => ( { width: 0 } ),
				save: () => {},
				restore: () => {},
				translate: () => {},
				scale: () => {},
				beginPath: () => {},
				moveTo: () => {},
				lineTo: () => {},
				stroke: () => {},
				fill: () => {},
				closePath: () => {},
				set fillStyle( _v ) {},
				set strokeStyle( _v ) {},
				set font( _v ) {},
				set textBaseline( _v ) {},
				set textAlign( _v ) {},
				set lineWidth( _v ) {},
			};
		};
	} );

	beforeEach( () => {
		sendMock = jest.fn();
		getCommandClient.mockReturnValue( { send: sendMock } );
		installMessageStreamMock();
	} );

	it( 'shows the Loading status while the list_logs request is in flight', () => {
		sendMock.mockReturnValue( new Promise( () => {} ) );
		const { container } = render( <RawLogs /> );
		expect( container.textContent ).toMatch( /Loading/ );
	} );

	it( 'shows "No logs available" when the catalog is empty', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /No logs available/ );
	} );

	it( 'renders a select populated from the list_logs catalog', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [
			{ key: 'firehose', label: 'Firehose' },
			{ key: 'errors', label: 'Errors' },
		] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-raw-logs-select'
		);
		expect( select ).not.toBeNull();
		expect( select.options.length ).toBe( 2 );
		expect( select.value ).toBe( 'firehose' );
	} );

	it( 'selecting a log calls onChange and updates state', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [
			{ key: 'firehose', label: 'Firehose' },
			{ key: 'errors', label: 'Errors' },
		] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-raw-logs-select'
		);
		fireEvent.change( select, { target: { value: 'errors' } } );
		expect( select.value ).toBe( 'errors' );
	} );

	it( 'renders the filter input + line count', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const filter = container.querySelector(
			'.newspack-nodes-raw-logs-search'
		);
		expect( filter ).not.toBeNull();
		const count = container.querySelector(
			'.newspack-nodes-raw-logs-count'
		);
		expect( count.textContent ).toMatch( /0.*lines/ );
	} );

	it( 'pause button toggles label between ▶ and ⏸', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const buttons = container.querySelectorAll(
			'.newspack-nodes-raw-logs-btn'
		);
		const pause = buttons[ 0 ];
		expect( pause.textContent ).toBe( '⏸' );
		fireEvent.click( pause );
		expect( pause.textContent ).toBe( '▶' );
	} );

	it( 'Clear button is rendered', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const clear = Array.from(
			container.querySelectorAll( '.newspack-nodes-raw-logs-btn' )
		).find( ( b ) => b.textContent === 'Clear' );
		expect( clear ).not.toBeUndefined();
		fireEvent.click( clear );
	} );

	it( 'renders error banner when useMessageStream surfaces error', async () => {
		installMessageStreamMock( { error: 'Reconnecting in 5s...' } );
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		expect( container.textContent ).toMatch( /Reconnecting/ );
	} );

	it( 'updates filter state on typing', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const filter = container.querySelector(
			'.newspack-nodes-raw-logs-search'
		);
		fireEvent.change( filter, { target: { value: 'foo' } } );
		expect( filter.value ).toBe( 'foo' );
	} );

	it( 'tolerates a list_logs send rejection without crashing', async () => {
		sendMock.mockRejectedValue( new Error( 'boom' ) );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		// The catch lands us in the "No logs available" state.
		expect( container.textContent ).toMatch( /No logs available/ );
	} );

	it( 'wires useMessageStream with the selected log and ms cadence', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [
			{ key: 'firehose', label: 'Firehose' },
		] );
		render( <RawLogs /> );
		await act( async () => {} );
		const lastCallProps = useMessageStream.mock.calls.at( -1 )[ 0 ];
		expect( lastCallProps.subscriptions ).toEqual( [ 'firehose' ] );
	} );

	it( 'onMessage handler appends parsed log lines to the internal buffer', async () => {
		jest.useFakeTimers();
		try {
			sendMock.mockResolvedValue( [] );
			unwrapCommandResponse.mockReturnValue( [
				{ key: 'firehose', label: 'Firehose' },
			] );
			const { container } = render( <RawLogs /> );
			await act( async () => {} );
			// Drive the component's onMessage callback directly.
			const onMessage =
				useMessageStream.mock.calls.at( -1 )[ 0 ].onMessage;
			// Need FROM=`{sub}.pN` and VALUE=text for transformLogLine.
			act( () => {
				onMessage(
					[ 1, 1234, 'firehose.p0', '', '1:1', '', 'a log line' ],
					{
						type: 1,
					}
				);
			} );
			act( () => {
				jest.advanceTimersByTime( 200 );
			} );
			const count = container.querySelector(
				'.newspack-nodes-raw-logs-count'
			);
			expect( count.textContent ).toMatch( /1.*lines/ );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'clicking Clear empties the line buffer and counter', async () => {
		jest.useFakeTimers();
		try {
			sendMock.mockResolvedValue( [] );
			unwrapCommandResponse.mockReturnValue( [
				{ key: 'firehose', label: 'Firehose' },
			] );
			const { container } = render( <RawLogs /> );
			await act( async () => {} );
			const onMessage =
				useMessageStream.mock.calls.at( -1 )[ 0 ].onMessage;
			act( () => {
				onMessage( [ 1, 0, 'firehose.p0', '', '1:1', '', 'one' ], {
					type: 1,
				} );
			} );
			act( () => {
				jest.advanceTimersByTime( 200 );
			} );
			const clear = Array.from(
				container.querySelectorAll( '.newspack-nodes-raw-logs-btn' )
			).find( ( b ) => b.textContent === 'Clear' );
			act( () => fireEvent.click( clear ) );
			const count = container.querySelector(
				'.newspack-nodes-raw-logs-count'
			);
			expect( count.textContent ).toMatch( /0.*lines/ );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'switching log resets the buffer and selectedLog state', async () => {
		sendMock.mockResolvedValue( [] );
		unwrapCommandResponse.mockReturnValue( [
			{ key: 'firehose', label: 'Firehose' },
			{ key: 'errors', label: 'Errors' },
		] );
		const { container } = render( <RawLogs /> );
		await act( async () => {} );
		const select = container.querySelector(
			'.newspack-nodes-raw-logs-select'
		);
		fireEvent.change( select, { target: { value: 'errors' } } );
		const lastCallProps = useMessageStream.mock.calls.at( -1 )[ 0 ];
		expect( lastCallProps.subscriptions ).toEqual( [ 'errors' ] );
	} );
} );

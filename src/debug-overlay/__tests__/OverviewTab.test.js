import { render, fireEvent, act } from '@testing-library/react';
import OverviewTab from '../tabs/OverviewTab';
import { IoTelemetry, OVERVIEW_STORAGE_KEY } from '../../runtime/io-telemetry';

beforeEach( () => {
	IoTelemetry.reset();
	try {
		window.localStorage.removeItem( OVERVIEW_STORAGE_KEY );
	} catch ( _e ) {
		// ignore
	}
} );

function renderTab( props = {} ) {
	return render( <OverviewTab publishHeader={ () => {} } { ...props } /> );
}

test( 'renders the metric cards and both rate-chart panels', () => {
	const { getByTestId, container } = renderTab();
	expect( getByTestId( 'overview-tab' ) ).toBeTruthy();
	const ids = [
		'byte-rate',
		'message-rate',
		'total-messages',
		'total-bytes',
		'warnings',
		'errors',
		'debug',
		'client-uptime',
		'sse-uptime',
	];
	for ( const id of ids ) {
		expect( getByTestId( `overview-card-${ id }` ) ).toBeTruthy();
	}
	const titles = [
		...container.querySelectorAll( '.nodes-topics__title' ),
	].map( ( el ) => el.textContent );
	expect( titles ).toEqual( [ 'Message Rate', 'Byte Rate' ] );
	// Cards keep their layout hook and consume the canonical surface role.
	const cards = [ ...container.querySelectorAll( '.nodes-card' ) ];
	expect( cards ).toHaveLength( ids.length );
	expect(
		cards.every( ( card ) =>
			card.classList.contains( 'newspack-nodes-card' )
		)
	).toBe( true );
} );

test( 'shows a client uptime card (time since the page loaded)', () => {
	const { getByTestId } = renderTab();
	const card = getByTestId( 'overview-card-client-uptime' );
	expect( card ).toBeTruthy();
	// Just-loaded in jsdom → a small "Ns" age, never the "-" empty sentinel.
	expect( card.textContent ).toMatch( /\d/ );
	expect( card.textContent ).toContain( 'Client Uptime' );
} );

test( 'shows an SSE uptime card reading "-" when no stream is connected', () => {
	IoTelemetry.markSseDisconnected();
	const { getByTestId } = renderTab();
	const card = getByTestId( 'overview-card-sse-uptime' );
	expect( card.textContent ).toContain( 'SSE Uptime' );
	expect( card.textContent ).toContain( '-' );
} );

test( 'the SSE uptime card shows an age once the stream is connected', () => {
	IoTelemetry.markSseConnected( Math.floor( Date.now() / 1000 ) - 5 );
	const { getByTestId } = renderTab();
	expect( getByTestId( 'overview-card-sse-uptime' ).textContent ).toMatch(
		/\d/
	);
} );

test( 'in/out card values render each number in its own right-aligned io cell', () => {
	const { getByTestId } = renderTab();
	// byte-rate shows ↓in/↑out in min-width cells so arrows don't shift.
	expect(
		getByTestId( 'overview-card-byte-rate' ).querySelectorAll(
			'.nodes-card__io'
		)
	).toHaveLength( 2 );
	// Single-value cards (warnings) have none.
	expect(
		getByTestId( 'overview-card-warnings' ).querySelectorAll(
			'.nodes-card__io'
		)
	).toHaveLength( 0 );
} );

test( 'shows the live cumulative warning/error/debug counts', () => {
	IoTelemetry.recordWarning();
	IoTelemetry.recordWarning();
	IoTelemetry.recordError( 3 );
	IoTelemetry.recordDebug();
	const { getByTestId } = renderTab();
	expect( getByTestId( 'overview-card-warnings' ).textContent ).toContain(
		'2'
	);
	expect( getByTestId( 'overview-card-errors' ).textContent ).toContain(
		'3'
	);
	expect( getByTestId( 'overview-card-debug' ).textContent ).toContain( '1' );
} );

test( 'lists the classified messages below the charts (newest first)', () => {
	IoTelemetry.recordDebug( 'a trace line' );
	IoTelemetry.recordWarning( 'WARNING: heads up' );
	IoTelemetry.recordError( 1, 'ERROR: boom' );
	const { getByTestId } = renderTab();
	const list = getByTestId( 'overview-messages' );
	const rows = [ ...list.querySelectorAll( '.nodes-overview__msg' ) ];
	expect(
		rows.map(
			( r ) => r.querySelector( '.nodes-overview__msg-text' ).textContent
		)
	).toEqual( [ 'ERROR: boom', 'WARNING: heads up', 'a trace line' ] );
	expect( rows[ 0 ].className ).toContain( 'nodes-overview__msg--error' );
	expect( rows[ 2 ].className ).toContain( 'nodes-overview__msg--debug' );
} );

test( 'labels the panel "Messages (this browser)" so it is not mistaken for server logs', () => {
	IoTelemetry.recordWarning( 'WARNING: heads up' );
	const { getByTestId } = renderTab();
	expect(
		getByTestId( 'overview-messages' ).querySelector( 'h3' ).textContent
	).toBe( 'Messages (this browser)' );
} );

test( 'shows a relative timestamp per message from its stored ts', () => {
	IoTelemetry.recordError( 1, 'ERROR: boom' );
	// Backdate the stored ts 65s → formatAge renders "1m" (distinct from 0s).
	IoTelemetry.messages[ 0 ].ts = Math.floor( Date.now() / 1000 ) - 65;
	const { getByTestId } = renderTab();
	const age = getByTestId( 'overview-messages' ).querySelector(
		'.nodes-overview__msg-age'
	);
	expect( age ).not.toBeNull();
	expect( age.textContent ).toContain( '1m' );
	expect( age.textContent ).toContain( 'ago' );
} );

test( 'level-filter chips hide messages of a toggled-off level', () => {
	IoTelemetry.recordError( 1, 'ERROR: boom' );
	IoTelemetry.recordWarning( 'WARNING: heads up' );
	IoTelemetry.recordDebug( 'a trace line' );
	const { getByTestId } = renderTab();
	const rows = () =>
		getByTestId( 'overview-messages' ).querySelectorAll(
			'.nodes-overview__msg'
		);
	// All three chips default on.
	expect( rows() ).toHaveLength( 3 );
	// Toggle the err chip off → the error line disappears, the rest stay.
	fireEvent.click( getByTestId( 'overview-chip-error' ) );
	expect( rows() ).toHaveLength( 2 );
	expect(
		getByTestId( 'overview-messages' ).querySelector(
			'.nodes-overview__msg--error'
		)
	).toBeNull();
	// Toggle it back on → the error line returns.
	fireEvent.click( getByTestId( 'overview-chip-error' ) );
	expect( rows() ).toHaveLength( 3 );
} );

test( 'renders the filter chips whenever there are messages', () => {
	IoTelemetry.recordDebug( 'a trace line' );
	const { getByTestId } = renderTab();
	for ( const level of [ 'error', 'warning', 'debug' ] ) {
		expect( getByTestId( `overview-chip-${ level }` ) ).toBeTruthy();
	}
} );

test( 'omits the message list when there are no messages', () => {
	const { queryByTestId } = renderTab();
	expect( queryByTestId( 'overview-messages' ) ).toBeNull();
} );

test( 'the Reset stats button clears the telemetry', () => {
	IoTelemetry.recordWarning();
	IoTelemetry.recordError( 3 );
	const { getByText } = renderTab();
	fireEvent.click( getByText( 'Reset stats' ) );
	const s = IoTelemetry.snapshot();
	expect( s.warnings ).toBe( 0 );
	expect( s.errors ).toBe( 0 );
} );

test( 'renders no header of its own (the panel owns the one shared header)', () => {
	const { container } = renderTab();
	expect( container.querySelector( '.topology-header' ) ).toBeNull();
	expect(
		container.querySelector( '[data-testid="overlay-header"]' )
	).toBeNull();
} );

test( 'clears any header extras the Console left on the shared header', () => {
	const publishHeader = jest.fn();
	renderTab( { publishHeader } );
	expect( publishHeader ).toHaveBeenCalledWith( null );
} );

test( 'a same-instant message at ring capacity still renders (monotonic key)', () => {
	// Frozen clock: every push shares one fractional ts (a burst logger).
	jest.useFakeTimers( { now: 1700000000200 } );
	try {
		const { getByTestId } = renderTab();
		act( () => {
			for ( let i = 0; i < 200; i++ ) {
				IoTelemetry.recordDebug( `filler ${ i }` );
			}
			IoTelemetry._notify();
		} );
		// Ring full + identical ts: the memo key must still move on a push.
		act( () => {
			IoTelemetry.recordWarning( 'WARNING: fresh straggler' );
			IoTelemetry._notify();
		} );
		expect( getByTestId( 'overview-messages' ).textContent ).toContain(
			'fresh straggler'
		);
	} finally {
		jest.useRealTimers();
	}
} );

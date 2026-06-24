import { render } from '@testing-library/react';
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

test( 'renders the seven metric cards and both rate-chart panels', () => {
	const { getByTestId, container } = renderTab();
	expect( getByTestId( 'overview-tab' ) ).toBeTruthy();
	for ( const id of [
		'byte-rate',
		'message-rate',
		'total-messages',
		'total-bytes',
		'warnings',
		'errors',
		'debug',
	] ) {
		expect( getByTestId( `overview-card-${ id }` ) ).toBeTruthy();
	}
	const titles = [
		...container.querySelectorAll( '.nodes-topics__title' ),
	].map( ( el ) => el.textContent );
	expect( titles ).toEqual( [ 'Message Rate', 'Byte Rate' ] );
	// Cards use the shared `.nodes-card` class (no overlay-specific styles).
	expect( container.querySelectorAll( '.nodes-card' ) ).toHaveLength( 7 );
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
	expect( rows.map( ( r ) => r.textContent ) ).toEqual( [
		'ERROR: boom',
		'WARNING: heads up',
		'a trace line',
	] );
	expect( rows[ 0 ].className ).toContain( 'nodes-overview__msg--error' );
	expect( rows[ 2 ].className ).toContain( 'nodes-overview__msg--debug' );
} );

test( 'omits the message list when there are no messages', () => {
	const { queryByTestId } = renderTab();
	expect( queryByTestId( 'overview-messages' ) ).toBeNull();
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

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

test( 'renders the six metric cards and both rate-chart panels', () => {
	const { getByTestId, container } = renderTab();
	expect( getByTestId( 'overview-tab' ) ).toBeTruthy();
	for ( const id of [
		'byte-rate',
		'message-rate',
		'total-messages',
		'total-bytes',
		'warnings',
		'errors',
	] ) {
		expect( getByTestId( `overview-card-${ id }` ) ).toBeTruthy();
	}
	const titles = [
		...container.querySelectorAll( '.nodes-topics__title' ),
	].map( ( el ) => el.textContent );
	expect( titles ).toEqual( [ 'Message Rate', 'Byte Rate' ] );
	// Cards use the shared `.nodes-card` class (no overlay-specific styles).
	expect( container.querySelectorAll( '.nodes-card' ) ).toHaveLength( 6 );
} );

test( 'shows the live cumulative warning/error counts', () => {
	IoTelemetry.recordWarning();
	IoTelemetry.recordWarning();
	IoTelemetry.recordError( 3 );
	const { getByTestId } = renderTab();
	expect( getByTestId( 'overview-card-warnings' ).textContent ).toContain(
		'2'
	);
	expect( getByTestId( 'overview-card-errors' ).textContent ).toContain(
		'3'
	);
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

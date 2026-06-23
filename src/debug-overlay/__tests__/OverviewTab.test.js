import { render, fireEvent } from '@testing-library/react';
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
	return render(
		<OverviewTab
			frame={ { w: 800, h: 600 } }
			onClose={ () => {} }
			onHeaderPointerDown={ () => {} }
			toggleMaximize={ () => {} }
			{ ...props }
		/>
	);
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

test( 'the close button invokes onClose', () => {
	const onClose = jest.fn();
	const { getByLabelText } = renderTab( { onClose } );
	fireEvent.click( getByLabelText( /close/i ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'pointer-down on the header starts a panel drag', () => {
	const onHeaderPointerDown = jest.fn();
	const { getByTestId } = renderTab( { onHeaderPointerDown } );
	fireEvent.pointerDown( getByTestId( 'overview-header' ) );
	expect( onHeaderPointerDown ).toHaveBeenCalledTimes( 1 );
} );

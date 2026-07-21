import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../runtime/message';
import LogsTab from '../tabs/LogsTab';

const POLLER = 'logs:poller';

beforeEach( () => Core.reset() );

// Feed a taillog/dmesg reply into the mounted poller and let React settle.
function publishLines( text ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { payload: text };
	act( () => Core.node( POLLER ).fill( m ) );
}

test( 'offers exactly the three sources and defaults to This browser', () => {
	const { getByTestId } = render( <LogsTab publishHeader={ () => {} } /> );
	const select = getByTestId( 'logs-source' );
	expect( [ ...select.options ].map( ( o ) => o.value ) ).toEqual( [
		'browser',
		'php',
		'debug',
	] );
	expect( select.value ).toBe( 'browser' );
} );

test( 'mounts one poller on the backbone reading the local dmesg ring by default', () => {
	render( <LogsTab publishHeader={ () => {} } /> );
	const poller = Core.node( POLLER );
	expect( poller ).toBeTruthy();
	// This browser → the LOCAL dmesg verb (empty target), not a server round-trip.
	expect( poller.verb ).toBe( 'dmesg' );
	expect( poller.target ).toBe( '' );
} );

test( 'renders each line classified, oldest to newest (newest at the bottom)', () => {
	const { container } = render( <LogsTab publishHeader={ () => {} } /> );
	publishLines( 'plain trace\nWARNING: careful\nERROR: boom' );
	const rows = [ ...container.querySelectorAll( '.nodes-logs__line' ) ];
	expect( rows.map( ( r ) => r.textContent ) ).toEqual( [
		'plain trace',
		'WARNING: careful',
		'ERROR: boom',
	] );
	expect( rows[ 0 ].className ).toContain( 'nodes-logs__line--debug' );
	expect( rows[ 1 ].className ).toContain( 'nodes-logs__line--warning' );
	expect( rows[ 2 ].className ).toContain( 'nodes-logs__line--error' );
} );

test( 'a toggled-off level chip hides that level, and toggling it back restores it', () => {
	const { getByTestId, container } = render(
		<LogsTab publishHeader={ () => {} } />
	);
	publishLines( 'plain trace\nWARNING: careful\nERROR: boom' );
	const lines = () => container.querySelectorAll( '.nodes-logs__line' );
	expect( lines() ).toHaveLength( 3 );
	fireEvent.click( getByTestId( 'logs-chip-error' ) );
	expect( lines() ).toHaveLength( 2 );
	expect( container.querySelector( '.nodes-logs__line--error' ) ).toBeNull();
	fireEvent.click( getByTestId( 'logs-chip-error' ) );
	expect( lines() ).toHaveLength( 3 );
} );

test( 'selecting a file source retargets the poller at taillog over the _http boundary', () => {
	const { getByTestId } = render( <LogsTab publishHeader={ () => {} } /> );
	// Capture what the immediate re-poll POSTs through the request-scope boundary.
	const posted = [];
	Core.node( '_http' ).client = {
		postBatch: async ( msgs ) => {
			posted.push( ...msgs );
			return [];
		},
	};
	act( () =>
		fireEvent.change( getByTestId( 'logs-source' ), {
			target: { value: 'php' },
		} )
	);
	const poller = Core.node( POLLER );
	expect( poller.verb ).toBe( 'taillog' );
	expect( poller.pollArgs ).toEqual( [ 'php' ] );
	expect( poller.target ).toBe( '_http' );
	expect( posted ).toHaveLength( 1 );
	expect( posted[ 0 ][ VALUE ] ).toEqual( {
		name: 'taillog',
		arguments: [ 'php' ],
	} );
} );

test( 'a graph rebuild re-applies the selected source to the fresh poller', () => {
	// Stub the boundary client so the immediate re-polls never hit fetch.
	const stubHttp = () => {
		Core.node( '_http' ).client = { postBatch: async () => [] };
	};
	const { getByTestId } = render( <LogsTab publishHeader={ () => {} } /> );
	stubHttp();
	act( () =>
		fireEvent.change( getByTestId( 'logs-source' ), {
			target: { value: 'php' },
		} )
	);
	expect( Core.node( POLLER ).verb ).toBe( 'taillog' );

	// Full rebuild replaces the poller; the php selection must survive it.
	act( () => {
		Core.bumpGraphGeneration();
		stubHttp();
	} );

	const rebuilt = Core.node( POLLER );
	expect( rebuilt.verb ).toBe( 'taillog' );
	expect( rebuilt.pollArgs ).toEqual( [ 'php' ] );
	expect( rebuilt.target ).toBe( '_http' );
} );

test( 'clears any header extras a sibling tab left on the shared header', () => {
	const publishHeader = jest.fn();
	render( <LogsTab publishHeader={ publishHeader } /> );
	expect( publishHeader ).toHaveBeenCalledWith( null );
} );

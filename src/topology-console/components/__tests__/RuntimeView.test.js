/**
 * RuntimeView tests — the current-scope timers + handles grids shown inside the
 * Inspector's Runtime modal. It mounts ONE `Dmesg` poller (verb `runtime_stats`,
 * target `_cwd`) on the backbone and renders its `{ timers, handles }` reply as
 * two click-to-sort grids; a drain spinner (next_ms <= 0 with fires climbing) is
 * flagged. Ported from the retired Runtime devtools tab.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import RuntimeView from '../RuntimeView';

const POLLER = 'runtime:poller';

beforeEach( () => Core.reset() );

// Feed a runtime_stats reply into the mounted poller and let React settle.
function publish( timers, handles ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { payload: { timers, handles } };
	act( () => Core.node( POLLER ).fill( m ) );
}

// Seed / refresh the console `_metadata` graph the Trace toggle derives from.
// Each call publishes a fresh state object so the reconcile effect re-runs.
// One PHP-shaped timer row; overrides the given fields.
function timer( over ) {
	return {
		id: 7,
		active: true,
		interval_ms: 250,
		mode: 'event_framework',
		next_ms: 120,
		oneshot: false,
		fires: 3,
		type: 'Timer_Node',
		name: 'tick0',
		...over,
	};
}

const rowNames = ( table ) =>
	[ ...table.querySelectorAll( 'tbody tr' ) ].map( ( tr ) =>
		tr.getAttribute( 'data-name' )
	);

test( 'mounts one runtime_stats poller on the backbone, targeting the current scope (_cwd)', () => {
	render( <RuntimeView /> );
	const poller = Core.node( POLLER );
	expect( poller ).toBeTruthy();
	expect( poller.verb ).toBe( 'runtime_stats' );
	expect( poller.target ).toBe( '_cwd' );
} );

test( 'tears the poller down on unmount (poll only while the modal is open)', () => {
	const { unmount } = render( <RuntimeView /> );
	expect( Core.node( POLLER ) ).toBeTruthy();
	unmount();
	expect( Core.node( POLLER ) ).toBeFalsy();
} );

test( 'renders the timer + handle rows into two grids', () => {
	const { getByTestId } = render( <RuntimeView /> );
	publish(
		[ timer( {} ) ],
		[ { id: 1, count: 42, type: 'SSE_Out_Node', name: 'sse0' } ]
	);
	const timers = getByTestId( 'runtime-timers' );
	expect( timers.textContent ).toContain( 'tick0' );
	expect( timers.textContent ).toContain( 'event_framework' );
	const handles = getByTestId( 'runtime-handles' );
	expect( handles.textContent ).toContain( 'sse0' );
	expect( handles.textContent ).toContain( '42' );
} );

test( 'sorts a grid numerically by a clicked column header, toggling asc then desc', () => {
	const { getByTestId } = render( <RuntimeView /> );
	publish(
		[
			timer( { name: 'alpha', fires: 30 } ),
			timer( { name: 'bravo', fires: 5 } ),
		],
		[]
	);
	const timers = getByTestId( 'runtime-timers' );
	// Default sort is by name ascending.
	expect( rowNames( timers ) ).toEqual( [ 'alpha', 'bravo' ] );
	// Click FIRES → numeric ascending: bravo(5) before alpha(30).
	act( () => fireEvent.click( getByTestId( 'runtime-timers-th-fires' ) ) );
	expect( rowNames( timers ) ).toEqual( [ 'bravo', 'alpha' ] );
	// Click again → descending: alpha(30) before bravo(5).
	act( () => fireEvent.click( getByTestId( 'runtime-timers-th-fires' ) ) );
	expect( rowNames( timers ) ).toEqual( [ 'alpha', 'bravo' ] );
} );

test( 'flags a spinner: next_ms <= 0 AND fires climbing across polls', () => {
	const { getByTestId } = render( <RuntimeView /> );
	const calm = timer( { name: 'calm0', next_ms: 500, fires: 999 } );
	// First poll seeds the fires baseline; second poll shows the climb.
	publish(
		[ timer( { name: 'spinner0', next_ms: -5, fires: 10 } ), calm ],
		[]
	);
	publish(
		[ timer( { name: 'spinner0', next_ms: -5, fires: 12 } ), calm ],
		[]
	);
	const timers = getByTestId( 'runtime-timers' );
	const rowOf = ( name ) =>
		timers.querySelector( `tbody tr[data-name="${ name }"]` );
	expect( rowOf( 'spinner0' ).className ).toContain(
		'nodes-runtime__row--spinner'
	);
	expect( rowOf( 'spinner0' ).textContent ).toContain( '⚠' );
	// next_ms > 0 is never a spinner, however fast it fires.
	expect( rowOf( 'calm0' ).className ).not.toContain( 'spinner' );
} );

test( 'does NOT flag a spinner when next_ms <= 0 but fires are not climbing', () => {
	const { getByTestId } = render( <RuntimeView /> );
	publish( [ timer( { name: 'stuck0', next_ms: -5, fires: 10 } ) ], [] );
	publish( [ timer( { name: 'stuck0', next_ms: -5, fires: 10 } ) ], [] );
	const row = getByTestId( 'runtime-timers' ).querySelector(
		'tbody tr[data-name="stuck0"]'
	);
	expect( row.className ).not.toContain( 'spinner' );
} );

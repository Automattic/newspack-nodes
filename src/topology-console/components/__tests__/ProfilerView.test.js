/**
 * ProfilerView tests — the Inspector's Profiler modal renders `list_profiles`
 * and nothing else: its seven columns, taken as rows via `-s` so the grid can
 * sort them without parsing the fixed-width table back apart.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { RouterNode } from '../../../runtime/router-node';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import ProfilerView from '../ProfilerView';

const POLLER = 'profiler:poller';

beforeEach( () => {
	Core.reset();
	RouterNode.profiles( null );
} );

// Values distinct from each other AND from every other column, so a row that
// mapped the wrong field fails rather than coinciding.
const ROW = {
	avg: 2.5,
	time: 5.0,
	count: 2,
	window: 16.0,
	rate: 0.125,
	age: 4,
	what: 'slowpoke',
};
const TOTAL = {
	avg: 1.25,
	time: 10.0,
	count: 8,
	window: 32.0,
	rate: 0.25,
	age: 9,
	what: '--total--',
};

// Feed a `list_profiles -s` reply into the mounted poller; let React settle.
function publish( rows ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { payload: rows };
	act( () => Core.node( POLLER ).fill( m ) );
}

test( 'polls list_profiles -s at the current scope (_cwd)', () => {
	render( <ProfilerView /> );
	const poller = Core.node( POLLER );
	expect( poller.verb ).toBe( 'list_profiles' );
	expect( poller.pollArgs ).toEqual( [ '-s' ] );
	expect( poller.target ).toBe( '_cwd' );
} );

test( 'tears the poller down on unmount (poll only while the modal is open)', () => {
	const { unmount } = render( <ProfilerView /> );
	expect( Core.node( POLLER ) ).toBeTruthy();
	unmount();
	expect( Core.node( POLLER ) ).toBeFalsy();
} );

test( "renders list_profiles' seven columns, in its order", () => {
	const { getByTestId } = render( <ProfilerView /> );
	publish( [ ROW, TOTAL ] );

	const headers = [
		...getByTestId( 'profiler-grid' ).querySelectorAll( 'thead th' ),
	].map( ( th ) => th.textContent.replace( /[^A-Z]/g, '' ) );

	expect( headers ).toEqual( [
		'AVERAGE',
		'TIME',
		'COUNT',
		'WINDOW',
		'RATE',
		'AGE',
		'WHAT',
	] );
} );

test( 'renders each profile row, WINDOW / RATE / AGE included', () => {
	const { getByTestId } = render( <ProfilerView /> );
	publish( [ ROW, TOTAL ] );

	const row = getByTestId( 'profiler-grid' ).querySelector( 'tbody tr' );
	expect( row.textContent ).toContain( '2.500000' ); // AVERAGE, 6dp
	expect( row.textContent ).toContain( '16.00' ); // WINDOW
	expect( row.textContent ).toContain( '0.13' ); // RATE, 2dp
	expect( row.textContent ).toContain( '4' ); // AGE
	expect( row.textContent ).toContain( 'slowpoke' ); // WHAT
} );

test( '--total-- is pinned to the footer, not left among the rows', () => {
	const { getByTestId } = render( <ProfilerView /> );
	publish( [ ROW, TOTAL ] );

	const grid = getByTestId( 'profiler-grid' );
	expect( grid.querySelectorAll( 'tbody tr' ) ).toHaveLength( 1 );
	expect( grid.querySelector( 'tfoot' ).textContent ).toContain(
		'--total--'
	);
	expect( grid.querySelector( 'tfoot' ).textContent ).toContain( '32.00' );
} );

test( 'the toolbar turns profiling on in the viewed scope', () => {
	const sent = [];
	const { getByText } = render( <ProfilerView /> );
	// Profiling off answers with the --total-- row alone.
	publish( [ { ...TOTAL, count: 0 } ] );
	Core.node( '_command_interpreter' ).fill = ( m ) => sent.push( m );

	fireEvent.click( getByText( 'profile' ) );

	const profile = sent.find( ( m ) => 'profile' === m[ VALUE ].name );
	expect( profile[ VALUE ].arguments ).toEqual( [ 'on' ] );
	// …and an immediate re-poll, so the grid does not wait out the interval.
	expect( sent.some( ( m ) => 'list_profiles' === m[ VALUE ].name ) ).toBe(
		true
	);
} );

test( 'a reply carrying real rows flips the control to stop profiling', () => {
	const { getByText } = render( <ProfilerView /> );
	publish( [ ROW, TOTAL ] );

	expect( getByText( 'stop profiling' ) ).toBeTruthy();
} );

// @longform
// The control is optimistic so the button responds on click, but a poll that
// disagrees must win — otherwise a `profile on` the scope rejected leaves the
// UI claiming profiling is live. One stale reply is tolerated (the request and
// the in-flight poll cross), the second surrenders.
test( 'an agreeing reply clears the optimistic override', () => {
	const { getByText } = render( <ProfilerView /> );
	publish( [ { ...TOTAL, count: 0 } ] );

	fireEvent.click( getByText( 'profile' ) );
	expect( getByText( 'stop profiling' ) ).toBeTruthy(); // optimistic

	publish( [ ROW, TOTAL ] ); // server agrees

	expect( getByText( 'stop profiling' ) ).toBeTruthy();
} );

test( 'two disagreeing replies surrender the optimistic override', () => {
	const { getByText } = render( <ProfilerView /> );
	publish( [ { ...TOTAL, count: 0 } ] );
	// Silence the immediate re-poll so only the replies below are counted.
	Core.node( POLLER ).fire = () => {};

	fireEvent.click( getByText( 'profile' ) );
	expect( getByText( 'stop profiling' ) ).toBeTruthy();

	// First disagreement is tolerated — the poll and the request crossed.
	publish( [ { ...TOTAL, count: 0 } ] );
	expect( getByText( 'stop profiling' ) ).toBeTruthy();

	// The second is the scope's answer: the request did not take.
	publish( [ { ...TOTAL, count: 0 } ] );
	expect( getByText( 'profile' ) ).toBeTruthy();
} );

test( 'sends nothing while unauthenticated, rather than an unsigned command', () => {
	const sent = [];
	const { getByText } = render( <ProfilerView /> );
	publish( [ { ...TOTAL, count: 0 } ] );
	Core.node( '_command_interpreter' ).fill = ( m ) => sent.push( m );
	// command() answers null until /auth lands.
	Core.node( POLLER ).command = () => null;

	fireEvent.click( getByText( 'profile' ) );

	expect( sent ).toEqual( [] );
} );

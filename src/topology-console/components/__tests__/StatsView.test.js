/**
 * StatsView tests — the "hot nodes" grid in the Inspector's Stats modal. Baseline
 * columns (NAME / COUNTER / LGST_MSG / READ / WRITTEN) come from the always-polled
 * `_metadata` graph; a runtime_stats poller (mounted only while open, RuntimeView's
 * pattern) joins Router profiling (AVG / TIME / COUNT) by node name, with an
 * Enable/Disable-profiling control and a distinct total row.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { MetadataNode } from '../../../runtime/metadata-node';
import { RouterNode } from '../../../runtime/router-node';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import names from '../../../runtime/reserved-node-names.json';
import StatsView from '../StatsView';

const POLLER = 'stats:poller';

beforeEach( () => {
	Core.reset();
	RouterNode.profiles( null );
} );

// Seed the always-polled `_metadata` graph the baseline columns read.
function seedMetadata( nodes ) {
	const meta = new MetadataNode();
	meta.name = names.METADATA;
	act( () => meta.setState( 'metadata', { nodes, edges: [], pwd: '' } ) );
}

// Feed a runtime_stats reply into the mounted poller and let React settle.
function publish( over ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = {
		payload: {
			timers: [],
			handles: [],
			profiles: null,
			profiles_total: null,
			...over,
		},
	};
	act( () => Core.node( POLLER ).fill( m ) );
}

test( 'mounts one runtime_stats poller on the backbone, targeting the current scope (_cwd)', () => {
	render( <StatsView /> );
	const poller = Core.node( POLLER );
	expect( poller.verb ).toBe( 'runtime_stats' );
	expect( poller.target ).toBe( '_cwd' );
} );

test( 'tears the poller down on unmount (poll only while the modal is open)', () => {
	const { unmount } = render( <StatsView /> );
	expect( Core.node( POLLER ) ).toBeTruthy();
	unmount();
	expect( Core.node( POLLER ) ).toBeFalsy();
} );

test( 'renders per-node NAME / COUNTER / LGST_MSG / READ / WRITTEN from the always-polled _metadata', () => {
	seedMetadata( [
		{
			id: 'alpha',
			count: 12,
			lgstMsg: 4096,
			bytesRead: 2048,
			bytesWritten: 512,
		},
	] );
	const { getByTestId } = render( <StatsView /> );
	const grid = getByTestId( 'stats-grid' );
	const row = grid.querySelector( 'tbody tr[data-name="alpha"]' );
	expect( row.textContent ).toContain( '12' ); // counter
	expect( row.textContent ).toContain( '4096' ); // lgst_msg (raw bytes)
	expect( row.textContent ).toContain( '2048' ); // read
	expect( row.textContent ).toContain( '512' ); // written
} );

test( 'shows "profiling" (no profile columns) when off, and enabling turns it on in the viewed scope', () => {
	seedMetadata( [
		{ id: 'alpha', count: 12, lgstMsg: 0, bytesRead: 0, bytesWritten: 0 },
	] );
	const { getByText, getByTestId, queryByText } = render( <StatsView /> );
	publish( { profiles: null, profiles_total: null } );
	expect( getByTestId( 'stats-grid' ).textContent ).not.toContain( 'AVG' );
	expect( queryByText( 'stop profiling' ) ).toBeNull();
	expect( RouterNode.profiles() ).toBeNull();
	fireEvent.click( getByText( 'profiling' ) );
	// The command round-trips the graph to _cwd and enables profiling for real.
	expect( RouterNode.profiles() ).not.toBeNull();
} );

test( 'joins AVG / TIME / COUNT by node name and pins a tfoot total row when profiling is on', () => {
	seedMetadata( [
		{
			id: 'alpha',
			count: 12,
			lgstMsg: 4096,
			bytesRead: 2048,
			bytesWritten: 512,
		},
	] );
	const { getByTestId, getByText } = render( <StatsView /> );
	publish( {
		profiles: [ { name: 'alpha', avg: 0.001234, time: 0.37, count: 7 } ],
		profiles_total: { avg: 0.002, time: 0.37, count: 7 },
	} );
	expect( getByText( 'stop profiling' ) ).toBeTruthy();
	const grid = getByTestId( 'stats-grid' );
	expect( grid.textContent ).toContain( 'AVG' );
	const row = grid.querySelector( 'tbody tr[data-name="alpha"]' );
	expect( row.textContent ).toContain( '12' ); // baseline counter preserved
	expect( row.textContent ).toContain( '0.001234' ); // joined profile avg
	// The total is a tfoot row: aligned with the columns, never in the sortable body.
	expect(
		grid.querySelector( 'tbody tr[data-name="--total--"]' )
	).toBeNull();
	const foot = grid.querySelector( 'tfoot tr' );
	expect( foot.textContent ).toContain( '--total--' );
	expect( foot.textContent ).toContain( '7' ); // profiles_total.count
} );

test( 'the tfoot sums COUNTER/READ/WRITTEN, maxes LGST_MSG, and takes AVG/TIME/COUNT from profiles_total', () => {
	seedMetadata( [
		{
			id: 'alpha',
			count: 12,
			lgstMsg: 4096,
			bytesRead: 2048,
			bytesWritten: 512,
		},
		{
			id: 'bravo',
			count: 30,
			lgstMsg: 1000,
			bytesRead: 100,
			bytesWritten: 8,
		},
	] );
	const { getByTestId } = render( <StatsView /> );
	publish( {
		profiles: [
			{ name: 'alpha', avg: 0.001234, time: 0.37, count: 7 },
			{ name: 'bravo', avg: 0.002, time: 0.63, count: 3 },
		],
		// The router aggregate — time here is DISTINCT from the visible-row sum
		// (1.0), so this pins profiles_total.time, not a re-sum of the rows.
		profiles_total: { avg: 0.005, time: 1.5, count: 10 },
	} );
	const foot = getByTestId( 'stats-grid' ).querySelector( 'tfoot tr' );
	expect( foot.textContent ).toContain( '--total--' );
	expect( foot.textContent ).toContain( '42' ); // COUNTER 12 + 30
	expect( foot.textContent ).toContain( '2148' ); // READ 2048 + 100
	expect( foot.textContent ).toContain( '520' ); // WRITTEN 512 + 8
	expect( foot.textContent ).toContain( '4096' ); // LGST_MSG max( 4096, 1000 )
	expect( foot.textContent ).toContain( '0.005000' ); // profiles_total.avg
	expect( foot.textContent ).toContain( '1.50' ); // profiles_total.time
	expect( foot.textContent ).toContain( '10' ); // profiles_total.count
} );

test( 'Enable flips the label to Disable optimistically at click, then reconciles to server truth', () => {
	seedMetadata( [
		{ id: 'alpha', count: 12, lgstMsg: 0, bytesRead: 0, bytesWritten: 0 },
	] );
	const { getByText, queryByText } = render( <StatsView /> );
	publish( { profiles: null, profiles_total: null } ); // server: profiling off
	// Silence the click's immediate re-poll so we observe the PURE optimistic
	// flip; in the live app that re-poll is an async round-trip, not synchronous.
	Core.node( POLLER ).fire = () => {};
	fireEvent.click( getByText( 'profiling' ) );
	// Optimistic: the label swaps now, before any poll reply confirms it.
	expect( getByText( 'stop profiling' ) ).toBeTruthy();
	expect( queryByText( 'profiling' ) ).toBeNull();
	// An agreeing reply confirms and clears the override to server truth.
	publish( { profiles: [], profiles_total: { avg: 0, time: 0, count: 0 } } );
	expect( getByText( 'stop profiling' ) ).toBeTruthy();
	expect( queryByText( 'profiling' ) ).toBeNull();
} );

test( 'a stale in-flight reply cannot flicker the optimistic toggle off', () => {
	seedMetadata( [
		{ id: 'alpha', count: 3, lgstMsg: 0, bytesRead: 0, bytesWritten: 0 },
	] );
	const { getByText, queryByText } = render( <StatsView /> );
	publish( { profiles: null, profiles_total: null } );
	// Silence the click's synchronous re-poll (live it is an async round-trip).
	Core.node( POLLER ).fire = () => {};
	fireEvent.click( getByText( 'profiling' ) );
	expect( getByText( 'stop profiling' ) ).not.toBeNull();
	// A reply minted BEFORE the click arrives late, carrying stale truth.
	publish( { profiles: null, profiles_total: null } );
	expect( queryByText( 'profiling' ) ).toBeNull();
	expect( getByText( 'stop profiling' ) ).not.toBeNull();
	// The next reply confirms; the override clears to agreeing server truth.
	publish( { profiles: [], profiles_total: { avg: 0, time: 0, count: 0 } } );
	expect( getByText( 'stop profiling' ) ).not.toBeNull();
} );

test( 'two disagreeing replies surrender the optimistic override (verb failed)', () => {
	seedMetadata( [
		{ id: 'alpha', count: 3, lgstMsg: 0, bytesRead: 0, bytesWritten: 0 },
	] );
	const { getByText } = render( <StatsView /> );
	publish( { profiles: null, profiles_total: null } );
	// Silence the re-poll; simulate a verb that failed server-side.
	Core.node( POLLER ).fire = () => {};
	fireEvent.click( getByText( 'profiling' ) );
	publish( { profiles: null, profiles_total: null } );
	publish( { profiles: null, profiles_total: null } );
	// Server truth held after two full replies: the button stops lying.
	expect( getByText( 'profiling' ) ).not.toBeNull();
} );

test( 'the "stop profiling" button turns profiling off in the viewed scope', () => {
	RouterNode.profiles( {
		alpha: { time: 0.3, count: 3, avg: 0.1, oldest: 100, timestamp: 130 },
	} );
	const { getByText } = render( <StatsView /> );
	publish( {
		profiles: [ { name: 'alpha', avg: 0.1, time: 0.3, count: 3 } ],
		profiles_total: { avg: 0.1, time: 0.3, count: 3 },
	} );
	fireEvent.click( getByText( 'stop profiling' ) );
	expect( RouterNode.profiles() ).toBeNull();
} );

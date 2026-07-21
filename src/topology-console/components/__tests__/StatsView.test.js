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

test( 'shows "Enable profiling" (no profile columns) when off, and enabling turns it on in the viewed scope', () => {
	seedMetadata( [
		{ id: 'alpha', count: 12, lgstMsg: 0, bytesRead: 0, bytesWritten: 0 },
	] );
	const { getByText, getByTestId, queryByText } = render( <StatsView /> );
	publish( { profiles: null, profiles_total: null } );
	expect( getByTestId( 'stats-grid' ).textContent ).not.toContain( 'AVG' );
	expect( queryByText( 'Disable profiling' ) ).toBeNull();
	expect( RouterNode.profiles() ).toBeNull();
	fireEvent.click( getByText( 'Enable profiling' ) );
	// The command round-trips the graph to _cwd and enables profiling for real.
	expect( RouterNode.profiles() ).not.toBeNull();
} );

test( 'joins AVG / TIME / COUNT by node name and renders a distinct total row when profiling is on', () => {
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
	expect( getByText( 'Disable profiling' ) ).toBeTruthy();
	const grid = getByTestId( 'stats-grid' );
	expect( grid.textContent ).toContain( 'AVG' );
	const row = grid.querySelector( 'tbody tr[data-name="alpha"]' );
	expect( row.textContent ).toContain( '12' ); // baseline counter preserved
	expect( row.textContent ).toContain( '0.001234' ); // joined profile avg
	// Total sits OUTSIDE the sortable grid body, rendered distinctly.
	expect(
		grid.querySelector( 'tbody tr[data-name="--total--"]' )
	).toBeNull();
	const total = getByTestId( 'stats-total' );
	expect( total.textContent ).toContain( '--total--' );
	expect( total.textContent ).toContain( 'count 7' );
} );

test( 'the "Disable profiling" button turns profiling off in the viewed scope', () => {
	RouterNode.profiles( {
		alpha: { time: 0.3, count: 3, avg: 0.1, oldest: 100, timestamp: 130 },
	} );
	const { getByText } = render( <StatsView /> );
	publish( {
		profiles: [ { name: 'alpha', avg: 0.1, time: 0.3, count: 3 } ],
		profiles_total: { avg: 0.1, time: 0.3, count: 3 },
	} );
	fireEvent.click( getByText( 'Disable profiling' ) );
	expect( RouterNode.profiles() ).toBeNull();
} );

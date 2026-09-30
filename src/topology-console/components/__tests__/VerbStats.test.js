/**
 * VerbStats tests — a Table's `verb_stats` as the Inspector's two Stats grids,
 * the counts (CALLS, ASKED, ANSWERED, BYTES) and the times (TOTAL, AVG, MAX):
 * one row per verb that has been called, bytes and times in human units, AVG
 * derived from TOTAL over CALLS, both grids sharing one sort, TOTAL descending
 * until a header in either says otherwise, and a one-line empty state for a
 * Table nothing has called.
 */

import { render, fireEvent } from '@testing-library/react';
import VerbStats from '../VerbStats';

// Every counter distinct from its neighbours and from zero, and each column
// ranking the verbs differently, so a grid sorted by the wrong key fails.
const row = ( calls, asked, answered, bytes, totalMs, maxMs ) => ( {
	calls,
	asked,
	answered,
	bytes,
	total_ms: totalMs,
	max_ms: maxMs,
} );
const STATS = {
	GET: row( 3, 17, 11, 2048, 4.5, 2.4 ),
	MGET: row( 50000, 40960, 39001, 12582912, 3200, 730.5 ),
	SADD: row( 0, 0, 0, 0, 0, 0 ),
	PURGE: row( 8, 4000, 312, 0, 60, 19.5 ),
	CHECKPOINT: row( 0, 0, 0, 0, 0, 0 ),
};

const cells = ( grid, selector ) =>
	[ ...grid.querySelectorAll( selector ) ].map( ( el ) => el.textContent );
const bodyRows = ( grid ) =>
	[ ...grid.querySelectorAll( 'tbody tr' ) ].map( ( tr ) =>
		cells( tr, 'td' )
	);
const verbs = ( grid ) => bodyRows( grid ).map( ( r ) => r[ 0 ] );
const sorted = ( grid ) => cells( grid, 'th.is-sorted' );

test( 'splits the counters into a counts grid and a times grid, TOTAL descending', () => {
	const { getByTestId } = render( <VerbStats stats={ STATS } /> );
	const counts = getByTestId( 'verb-stats-counts' );
	const times = getByTestId( 'verb-stats-times' );
	expect( cells( counts, 'thead th' ) ).toEqual( [
		'VERB',
		'CALLS',
		'ASKED',
		'ANSWERED',
		'BYTES',
	] );
	expect( cells( times, 'thead th' ) ).toEqual( [
		'VERB',
		'TOTAL ▼',
		'AVG',
		'MAX',
	] );
	expect( bodyRows( counts ) ).toEqual( [
		[
			'MGET',
			( 50000 ).toLocaleString(),
			( 40960 ).toLocaleString(),
			( 39001 ).toLocaleString(),
			'12 MB',
		],
		[ 'PURGE', '8', ( 4000 ).toLocaleString(), '312', '0 B' ],
		[ 'GET', '3', '17', '11', '2 KB' ],
	] );
	expect( bodyRows( times ) ).toEqual( [
		[ 'MGET', '3.20s', '64us', '730.5ms' ],
		[ 'PURGE', '60.0ms', '7.5ms', '19.5ms' ],
		[ 'GET', '4.5ms', '1.5ms', '2.4ms' ],
	] );
	expect( sorted( counts ) ).toEqual( [] );
	expect( sorted( times ) ).toEqual( [ 'TOTAL ▼' ] );
} );

test( 'a header click in the counts grid re-sorts both grids', () => {
	const { getByTestId } = render( <VerbStats stats={ STATS } /> );
	fireEvent.click( getByTestId( 'verb-stats-counts-th-bytes' ) );
	const counts = getByTestId( 'verb-stats-counts' );
	const times = getByTestId( 'verb-stats-times' );
	expect( verbs( counts ) ).toEqual( [ 'PURGE', 'GET', 'MGET' ] );
	expect( verbs( times ) ).toEqual( [ 'PURGE', 'GET', 'MGET' ] );
	expect( sorted( counts ) ).toEqual( [ 'BYTES ▲' ] );
	expect( sorted( times ) ).toEqual( [] );
} );

test( 'a header click in the times grid re-sorts both grids', () => {
	const { getByTestId } = render( <VerbStats stats={ STATS } /> );
	fireEvent.click( getByTestId( 'verb-stats-times-th-max_ms' ) );
	const counts = getByTestId( 'verb-stats-counts' );
	const times = getByTestId( 'verb-stats-times' );
	expect( verbs( counts ) ).toEqual( [ 'GET', 'PURGE', 'MGET' ] );
	expect( verbs( times ) ).toEqual( [ 'GET', 'PURGE', 'MGET' ] );
	expect( sorted( counts ) ).toEqual( [] );
	expect( sorted( times ) ).toEqual( [ 'MAX ▲' ] );
} );

test( 'a Table with no calls shows a one-line empty state and no grid', () => {
	const { queryByTestId, getByText } = render(
		<VerbStats
			stats={ { GET: row( 0, 0, 0, 0, 0, 0 ), SADD: STATS.SADD } }
		/>
	);
	expect( queryByTestId( 'verb-stats-counts' ) ).toBeNull();
	expect( queryByTestId( 'verb-stats-times' ) ).toBeNull();
	expect(
		getByText( 'No calls since the Table was built or reset.' )
	).not.toBeNull();
} );

/**
 * VerbStats tests — a Table's `verb_stats` as the Inspector's Stats grid: one
 * row per verb that has been called, bytes and times in human units, AVG
 * derived from TOTAL over CALLS, TOTAL descending until a header says
 * otherwise, and a one-line empty state for a Table nothing has called.
 */

import { render, fireEvent } from '@testing-library/react';
import VerbStats from '../VerbStats';

// Every counter distinct from its neighbours and from zero, so a column that
// read the wrong key fails rather than coinciding.
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
	MGET: row( 1250, 40960, 39001, 166303744, 3200, 950 ),
	SADD: row( 0, 0, 0, 0, 0, 0 ),
	PURGE: row( 8, 4000, 312, 0, 60, 19.5 ),
	CHECKPOINT: row( 0, 0, 0, 0, 0, 0 ),
};

const bodyRows = ( grid ) =>
	[ ...grid.querySelectorAll( 'tbody tr' ) ].map( ( tr ) =>
		[ ...tr.querySelectorAll( 'td' ) ].map( ( td ) => td.textContent )
	);

test( 'renders one row per called verb, TOTAL descending, in human units', () => {
	const { getByTestId } = render( <VerbStats stats={ STATS } /> );
	const grid = getByTestId( 'verb-stats-grid' );
	const heads = [ ...grid.querySelectorAll( 'thead th' ) ].map(
		( th ) => th.textContent
	);
	expect( heads ).toEqual( [
		'VERB',
		'CALLS',
		'ASKED',
		'ANSWERED',
		'BYTES',
		'TOTAL ▼',
		'AVG',
		'MAX',
	] );
	expect( bodyRows( grid ) ).toEqual( [
		[
			'MGET',
			( 1250 ).toLocaleString(),
			( 40960 ).toLocaleString(),
			( 39001 ).toLocaleString(),
			'159 MB',
			'3.20s',
			'2.6ms',
			'950.0ms',
		],
		[
			'PURGE',
			'8',
			( 4000 ).toLocaleString(),
			'312',
			'0 B',
			'60.0ms',
			'7.5ms',
			'19.5ms',
		],
		[ 'GET', '3', '17', '11', '2 KB', '4.5ms', '1.5ms', '2.4ms' ],
	] );
} );

test( 'a header click sorts by that column on the raw value', () => {
	const { getByTestId } = render( <VerbStats stats={ STATS } /> );
	fireEvent.click( getByTestId( 'verb-stats-grid-th-bytes' ) );
	expect(
		bodyRows( getByTestId( 'verb-stats-grid' ) ).map( ( r ) => r[ 0 ] )
	).toEqual( [ 'PURGE', 'GET', 'MGET' ] );
} );

test( 'a Table with no calls shows a one-line empty state and no grid', () => {
	const { queryByTestId, getByText } = render(
		<VerbStats
			stats={ { GET: row( 0, 0, 0, 0, 0, 0 ), SADD: STATS.SADD } }
		/>
	);
	expect( queryByTestId( 'verb-stats-grid' ) ).toBeNull();
	expect(
		getByText( 'No calls since the Table was built or reset.' )
	).not.toBeNull();
} );

/**
 * useSeriesSelection — which of a chart's series the reader asked to see.
 *
 * An empty selection means every series; a plain pick shows that one alone; a
 * modified pick adds to or removes from the set; and a label the chart no
 * longer carries falls out of the effective set on its own.
 */

import { renderHook, act } from '@testing-library/react';
import { useSeriesSelection, useLegend } from '../useSeriesSelection';

const LABELS = [ 'firehose.p0', 'firehose.p1', 'jobs.p0' ];

it( 'shows every series until something is picked', () => {
	const { result } = renderHook( () => useSeriesSelection( LABELS ) );
	expect( result.current.selected.size ).toBe( 0 );
	expect( LABELS.every( result.current.isShown ) ).toBe( true );
} );

it( 'a plain pick shows that series alone', () => {
	const { result } = renderHook( () => useSeriesSelection( LABELS ) );
	act( () => result.current.onSelect( 'jobs.p0', false ) );
	expect( [ ...result.current.selected ] ).toEqual( [ 'jobs.p0' ] );
	expect( result.current.isShown( 'jobs.p0' ) ).toBe( true );
	expect( result.current.isShown( 'firehose.p0' ) ).toBe( false );

	// A plain pick of another replaces, rather than adds.
	act( () => result.current.onSelect( 'firehose.p1', false ) );
	expect( [ ...result.current.selected ] ).toEqual( [ 'firehose.p1' ] );
} );

it( 'a modified pick toggles a series in the set', () => {
	const { result } = renderHook( () => useSeriesSelection( LABELS ) );
	act( () => result.current.onSelect( 'jobs.p0', false ) );
	act( () => result.current.onSelect( 'firehose.p0', true ) );
	expect( [ ...result.current.selected ].sort() ).toEqual( [
		'firehose.p0',
		'jobs.p0',
	] );
	act( () => result.current.onSelect( 'jobs.p0', true ) );
	expect( [ ...result.current.selected ] ).toEqual( [ 'firehose.p0' ] );
} );

it( 'a plain pick of the only selected series clears back to all', () => {
	const { result } = renderHook( () => useSeriesSelection( LABELS ) );
	act( () => result.current.onSelect( 'jobs.p0', false ) );
	act( () => result.current.onSelect( 'jobs.p0', false ) );
	expect( result.current.selected.size ).toBe( 0 );
	expect( result.current.isShown( 'firehose.p0' ) ).toBe( true );
} );

it( 'a series the chart no longer carries leaves the effective set', () => {
	const { result, rerender } = renderHook(
		( { labels } ) => useSeriesSelection( labels ),
		{ initialProps: { labels: LABELS } }
	);
	act( () => result.current.onSelect( 'jobs.p0', false ) );
	act( () => result.current.onSelect( 'firehose.p1', true ) );

	// The breakdown switched: jobs.p0 is gone, firehose.p1 stays picked.
	rerender( { labels: [ 'firehose.p0', 'firehose.p1' ] } );
	expect( [ ...result.current.selected ] ).toEqual( [ 'firehose.p1' ] );
	expect( result.current.isShown( 'firehose.p0' ) ).toBe( false );

	// Nothing picked survives: back to every series, not an empty chart.
	rerender( { labels: [ 'edge-77', 'edge-78' ] } );
	expect( result.current.selected.size ).toBe( 0 );
	expect( result.current.isShown( 'edge-77' ) ).toBe( true );
} );

it( 'a pick restates the whole intent: a retired label does not ride along', () => {
	const { result, rerender } = renderHook(
		( { labels } ) => useSeriesSelection( labels ),
		{ initialProps: { labels: LABELS } }
	);
	act( () => result.current.onSelect( 'jobs.p0', false ) );
	act( () => result.current.onSelect( 'firehose.p1', true ) );
	rerender( { labels: [ 'firehose.p0', 'firehose.p1' ] } );

	// Backing firehose.p1 out leaves nothing picked: every series again…
	act( () => result.current.onSelect( 'firehose.p1', true ) );
	expect( result.current.selected.size ).toBe( 0 );

	// …and jobs.p0 returning does not snap the chart to it unasked.
	rerender( { labels: LABELS } );
	expect( result.current.selected.size ).toBe( 0 );
} );

describe( 'useLegend', () => {
	const SERIES = [
		{ label: 'firehose.p0', values: [ { value: 3 } ] },
		{ label: 'firehose.p1', values: [ { value: 7 } ] },
		{ label: 'jobs.p0', values: [ { value: 5 } ] },
	];
	const colorAt = ( label, i ) => `c${ i }:${ label }`;

	it( 'colours every series by its place in the full list', () => {
		const { result } = renderHook( () => useLegend( SERIES, colorAt ) );
		expect( result.current.legendItems ).toEqual( [
			{ label: 'firehose.p0', color: 'c0:firehose.p0' },
			{ label: 'firehose.p1', color: 'c1:firehose.p1' },
			{ label: 'jobs.p0', color: 'c2:jobs.p0' },
		] );
		expect( result.current.drawn.map( ( s ) => s.label ) ).toEqual(
			SERIES.map( ( s ) => s.label )
		);
	} );

	it( 'a pick narrows what is drawn and keeps each colour its rank gave it', () => {
		const { result } = renderHook( () => useLegend( SERIES, colorAt ) );
		act( () => result.current.onSelect( 'jobs.p0', false ) );
		expect( result.current.drawn ).toEqual( [
			{ ...SERIES[ 2 ], color: 'c2:jobs.p0' },
		] );
		expect( [ ...result.current.selected ] ).toEqual( [ 'jobs.p0' ] );
		// The legend still lists every series, so the pick can be undone.
		expect( result.current.legendItems ).toHaveLength( 3 );
	} );

	it( 'holds its outputs steady across a render that moved nothing', () => {
		const { result, rerender } = renderHook( () =>
			useLegend( SERIES, colorAt )
		);
		const first = result.current;
		rerender();
		expect( result.current.legendItems ).toBe( first.legendItems );
		expect( result.current.drawn ).toBe( first.drawn );
	} );
} );

/**
 * A hull's sparklines must show the history that ALREADY happened — useGraphRates
 * has been recording every node since page load, so selecting a hull should reveal
 * that history, not start a fresh accumulation from zero.
 */
import { aggregateSeries } from '../aggregateSeries';

// One useGraphRates entry.
const entry = ( history, readHistory, writtenHistory ) => ( {
	history,
	readHistory,
	writtenHistory,
} );

describe( 'aggregateSeries', () => {
	it( 'splits messages in/out by source vs sink, like processStats', () => {
		const nodes = [
			{ id: 'src', has_target: true, accepts_fill: false },
			{ id: 'sink', has_target: false, accepts_fill: true },
		];
		const rates = new Map( [
			[ 'src', entry( [ 3, 7 ], [ 0, 0 ], [ 0, 0 ] ) ],
			[ 'sink', entry( [ 40, 90 ], [ 0, 0 ], [ 0, 0 ] ) ],
		] );

		expect( aggregateSeries( rates, nodes ) ).toEqual( {
			in: [ 3, 7 ],
			out: [ 40, 90 ],
			read: [ 0, 0 ],
			write: [ 0, 0 ],
		} );
	} );

	it( 'sums bytes across EVERY member, source or not', () => {
		const nodes = [
			{ id: 'a', has_target: true, accepts_fill: false },
			{ id: 'b', has_target: false, accepts_fill: true },
		];
		const rates = new Map( [
			[ 'a', entry( [ 0 ], [ 100 ], [ 5 ] ) ],
			[ 'b', entry( [ 0 ], [ 20 ], [ 6 ] ) ],
		] );

		const series = aggregateSeries( rates, nodes );
		expect( series.read ).toEqual( [ 120 ] );
		expect( series.write ).toEqual( [ 11 ] );
	} );

	it( 'right-aligns histories of different lengths — a late node warmed last', () => {
		// `old` has 3 samples, `late` warmed two polls later and has 1. The last
		// sample of each is the SAME poll, so they must line up at the end.
		const nodes = [
			{ id: 'old', has_target: true, accepts_fill: false },
			{ id: 'late', has_target: true, accepts_fill: false },
		];
		const rates = new Map( [
			[ 'old', entry( [ 1, 2, 4 ], [], [] ) ],
			[ 'late', entry( [ 8 ], [], [] ) ],
		] );

		expect( aggregateSeries( rates, nodes ).in ).toEqual( [ 1, 2, 12 ] );
	} );

	it( 'ignores a node with no recorded history — it never carried data', () => {
		const nodes = [
			{ id: 'src', has_target: true, accepts_fill: false },
			{ id: 'cold', has_target: true, accepts_fill: false },
		];
		const rates = new Map( [ [ 'src', entry( [ 9 ], [], [] ) ] ] );

		expect( aggregateSeries( rates, nodes ).in ).toEqual( [ 9 ] );
	} );

	it( 'is empty when nothing is scoped', () => {
		expect( aggregateSeries( new Map(), [] ) ).toEqual( {
			in: [],
			out: [],
			read: [],
			write: [],
		} );
	} );
} );

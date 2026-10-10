import { BUCKET_S, foldInto, bucketTotals } from '../probe-stream-view-node';
import { bucketsFrom } from '../../__tests__/bucketTestUtils';

// Fold samples into one row, then read back that row's buckets.
const folded = ( samples, row = 'kea-3.p2' ) => {
	const rows = new Map();
	for ( const s of samples ) {
		foldInto( rows, row, s );
	}
	return [ ...rows.get( row ).values() ];
};

describe( 'foldInto', () => {
	it( 'floors each sample onto the 180-second grid, one bucket per start', () => {
		expect( BUCKET_S ).toBe( 180 );
		const starts = folded( [
			{ ts: 1755000179, msgs: 1 },
			{ ts: 1755000180, msgs: 1 },
		] ).map( ( b ) => b.start );
		expect( starts ).toEqual( [ 1755000000, 1755000180 ] );
	} );

	it( 'tallies each numeric field: sum, max and the newest reading', () => {
		const [ b ] = folded( [
			{
				ts: 1755000015,
				worker: 'kea-3.p2',
				elapsed: 14,
				msgs: 3,
				backlog: 700,
			},
			{
				ts: 1755000030,
				worker: 'kea-3.p2',
				elapsed: 16,
				msgs: 5,
				backlog: 410,
			},
		] );
		expect( b.start ).toBe( 1755000000 );
		expect( b.worker ).toBe( 'kea-3.p2' );
		expect( b.f.msgs ).toEqual( {
			sum: 8,
			max: 5,
			last: 5,
			lastTs: 1755000030,
		} );
		expect( b.f.elapsed.sum ).toBe( 30 );
		expect( b.f.backlog.last ).toBe( 410 );
		expect( b.f.backlog.max ).toBe( 700 );
	} );

	it( 'files the bucket under the row it is given, whatever the sample names', () => {
		const [ b ] = folded(
			[ { ts: 1755000015, worker: 'emu-6.p0', endBytes: 5780 } ],
			''
		);
		expect( b.worker ).toBe( '' );
	} );

	it( 'keeps the newest reading as last when an older sample folds after it', () => {
		const [ b ] = folded( [
			{ ts: 1755000090, cacheSize: 61 },
			{ ts: 1755000045, cacheSize: 29 },
		] );
		expect( b.f.cacheSize.last ).toBe( 61 );
		expect( b.f.cacheSize.lastTs ).toBe( 1755000090 );
	} );

	it( 'adds no tally for a null field, a string or the ts', () => {
		const [ b ] = folded( [
			{
				ts: 1755000015,
				worker: 'kea-3.p2',
				backlog: null,
				elapsed: 15,
			},
		] );
		expect( Object.keys( b.f ) ).toEqual( [ 'elapsed' ] );
	} );
} );

describe( 'bucketTotals', () => {
	it( 'sums each field across buckets and keeps the largest max, zeros for a field none carry', () => {
		const buckets = bucketsFrom( [
			{
				ts: 1755000015,
				worker: 'kea-3.p2',
				runsDelta: 3,
				maxDurationMs: 410,
			},
			{
				ts: 1755000200,
				worker: 'kea-3.p2',
				runsDelta: 5,
				maxDurationMs: 95,
			},
			{
				ts: 1755000020,
				worker: 'tui-1.p0',
				runsDelta: 2,
				maxDurationMs: 770,
			},
		] );
		expect(
			bucketTotals( buckets, [
				'runsDelta',
				'maxDurationMs',
				'errorsDelta',
			] )
		).toEqual( {
			runsDelta: { sum: 10, max: 5 },
			maxDurationMs: { sum: 1275, max: 770 },
			errorsDelta: { sum: 0, max: 0 },
		} );
	} );
} );

describe( 'bucketsFrom (test utility)', () => {
	it( 'groups by worker and bucket, each worker’s buckets in turn', () => {
		const buckets = bucketsFrom( [
			{ ts: 1755000200, worker: 'kea-3.p2', msgs: 1 },
			{ ts: 1755000015, worker: 'tui-1.p0', msgs: 4 },
			{ ts: 1755000015, worker: 'kea-3.p2', msgs: 2 },
			{ ts: 1755000030, worker: 'kea-3.p2', msgs: 3 },
		] );
		expect(
			buckets.map( ( b ) => [ b.worker, b.start, b.f.msgs.sum ] )
		).toEqual( [
			[ 'kea-3.p2', 1755000180, 1 ],
			[ 'kea-3.p2', 1755000000, 5 ],
			[ 'tui-1.p0', 1755000000, 4 ],
		] );
	} );
} );

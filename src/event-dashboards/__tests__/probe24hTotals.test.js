import { probe24hTotals } from '../probe24hTotals';

// A topicprobe:view consumer: a source it tails + a per-partition rate series.
const consumer = ( source, series ) => ( { source, series } );
const pt = ( ts, msgRate, byteRate ) => ( {
	ts,
	msgRate,
	byteRate,
	backlog: 0,
} );

it( 'integrates rate × dt over a series into produced totals', () => {
	// Two 15s intervals at 2 msg/s and 100 B/s → 60 msgs, 3000 bytes.
	const t = probe24hTotals( {
		r1: consumer( 's', [
			pt( 0, 0, 0 ),
			pt( 15, 2, 100 ),
			pt( 30, 2, 100 ),
		] ),
	} );
	expect( t.msgs ).toBe( 60 );
	expect( t.bytes ).toBe( 3000 );
} );

it( 'does NOT double-count readers tailing the SAME source', () => {
	const s = [ pt( 0, 0, 0 ), pt( 15, 2, 100 ) ];
	const t = probe24hTotals( {
		r1: consumer( 'firehose.p0', s ),
		r2: consumer( 'firehose.p0', s ),
	} );
	expect( t.msgs ).toBe( 30 );
	expect( t.bytes ).toBe( 1500 );
} );

it( 'sums DISTINCT sources', () => {
	const t = probe24hTotals( {
		r1: consumer( 'a', [ pt( 0, 0, 0 ), pt( 15, 2, 100 ) ] ),
		r2: consumer( 'b', [ pt( 0, 0, 0 ), pt( 15, 4, 200 ) ] ),
	} );
	expect( t.msgs ).toBe( 30 + 60 );
	expect( t.bytes ).toBe( 1500 + 3000 );
} );

it( 'merges readers of one source by ts so a newer-but-shorter reader is not dropped', () => {
	// Union of r1 (0-15) + r2 (15-45): full 0-45 at 2 msg/s = 90 msgs, 4500 B.
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 0, 0, 0 ), pt( 15, 2, 100 ) ] ),
		r2: consumer( 's', [
			pt( 15, 2, 100 ),
			pt( 30, 2, 100 ),
			pt( 45, 2, 100 ),
		] ),
	} );
	expect( t.msgs ).toBe( 90 );
	expect( t.bytes ).toBe( 4500 );
} );

it( 'a reset interval (rate 0) contributes nothing, never negative', () => {
	const t = probe24hTotals( {
		r1: consumer( 's', [
			pt( 0, 5, 5 ),
			pt( 15, 0, 0 ),
			pt( 30, 2, 100 ),
		] ),
	} );
	expect( t.msgs ).toBe( 30 );
	expect( t.bytes ).toBe( 1500 );
} );

it( 'a single sample or empty input totals zero', () => {
	expect(
		probe24hTotals( { r1: consumer( 's', [ pt( 0, 9, 9 ) ] ) } )
	).toEqual( { msgs: 0, bytes: 0 } );
	expect( probe24hTotals( {} ) ).toEqual( { msgs: 0, bytes: 0 } );
	expect( probe24hTotals( null ) ).toEqual( { msgs: 0, bytes: 0 } );
} );

it( 'ignores non-advancing timestamps (dt <= 0)', () => {
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 30, 0, 0 ), pt( 15, 2, 100 ) ] ),
	} );
	expect( t ).toEqual( { msgs: 0, bytes: 0 } );
} );

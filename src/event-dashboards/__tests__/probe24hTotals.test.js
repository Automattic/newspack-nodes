import { probe24hTotals } from '../probe24hTotals';

// A topicprobe:view consumer: a source it tails + a per-partition sample series.
const consumer = ( source, series ) => ( { source, series } );
const pt = ( ts, msgs, bytes ) => ( { ts, msgs, bytes, backlog: 0 } );

it( 'sums each sample’s own delta into produced totals', () => {
	// Three samples of 30 msgs / 1500 B each.
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 0, 30, 1500 ), pt( 15, 30, 1500 ) ] ),
	} );
	expect( t.msgs ).toBe( 60 );
	expect( t.bytes ).toBe( 3000 );
} );

it( 'counts the FIRST sample too (a self-contained record needs no prior)', () => {
	const t = probe24hTotals( { r1: consumer( 's', [ pt( 0, 91, 1820 ) ] ) } );
	expect( t ).toEqual( { msgs: 91, bytes: 1820 } );
} );

it( 'does NOT double-count readers tailing the SAME source', () => {
	const s = [ pt( 0, 30, 1500 ), pt( 15, 30, 1500 ) ];
	const t = probe24hTotals( {
		r1: consumer( 'firehose.p0', s ),
		r2: consumer( 'firehose.p0', s ),
	} );
	expect( t.msgs ).toBe( 60 );
	expect( t.bytes ).toBe( 3000 );
} );

it( 'sums DISTINCT sources', () => {
	const t = probe24hTotals( {
		r1: consumer( 'a', [ pt( 15, 30, 1500 ) ] ),
		r2: consumer( 'b', [ pt( 15, 60, 3000 ) ] ),
	} );
	expect( t.msgs ).toBe( 90 );
	expect( t.bytes ).toBe( 4500 );
} );

it( 'merges readers of one source by ts so a newer-but-shorter reader is not dropped', () => {
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 0, 30, 1500 ), pt( 15, 30, 1500 ) ] ),
		r2: consumer( 's', [
			pt( 15, 30, 1500 ),
			pt( 30, 30, 1500 ),
			pt( 45, 30, 1500 ),
		] ),
	} );
	expect( t.msgs ).toBe( 120 );
	expect( t.bytes ).toBe( 6000 );
} );

it( 'an idle interval contributes nothing, and a negative delta never subtracts', () => {
	const t = probe24hTotals( {
		r1: consumer( 's', [
			pt( 0, 30, 1500 ),
			pt( 15, 0, 0 ),
			pt( 30, -5, -100 ),
		] ),
	} );
	expect( t ).toEqual( { msgs: 30, bytes: 1500 } );
} );

it( 'an empty input totals zero', () => {
	expect( probe24hTotals( {} ) ).toEqual( { msgs: 0, bytes: 0 } );
	expect( probe24hTotals( null ) ).toEqual( { msgs: 0, bytes: 0 } );
} );

import { probe24hTotals } from '../probe24hTotals';
import { bucketsFrom } from './bucketTestUtils';

// A topicprobe:view consumer: a source it tails + the buckets of its samples.
const consumer = ( source, samples ) => ( {
	source,
	buckets: bucketsFrom( samples ),
} );
// One probe record: `elapsed` is the window `ts` closes, as the view publishes.
const CADENCE_S = 15;
const pt = ( ts, msgs, bytes ) => ( {
	ts,
	elapsed: CADENCE_S,
	msgs,
	bytes,
	backlog: 0,
} );

it( 'sums each sample’s own delta into produced totals', () => {
	// Three samples of 30 msgs / 1500 B each.
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 0, 30, 1500 ), pt( 15, 30, 1500 ) ] ),
	} );
	expect( t.msgs ).toBe( 60 );
	expect( t.bytes ).toBe( 3000 );
} );

it( 'sums two buckets of one reader', () => {
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 0, 30, 1500 ), pt( 200, 47, 2350 ) ] ),
	} );
	expect( t ).toEqual( { msgs: 77, bytes: 3850 } );
} );

it( 'counts the FIRST sample too (a self-contained record needs no prior)', () => {
	const t = probe24hTotals( { r1: consumer( 's', [ pt( 0, 91, 1820 ) ] ) } );
	expect( t ).toEqual( { msgs: 91, bytes: 1820 } );
} );

it( 'counts each reader tailing the SAME source, as the stacked chart does', () => {
	const t = probe24hTotals( {
		r1: consumer( 'firehose.p0', [
			pt( 0, 30, 1500 ),
			pt( 15, 30, 1500 ),
		] ),
		r2: consumer( 'firehose.p0', [ pt( 0, 41, 1700 ) ] ),
	} );
	expect( t.msgs ).toBe( 101 );
	expect( t.bytes ).toBe( 4700 );
} );

it( 'sums DISTINCT sources', () => {
	const t = probe24hTotals( {
		r1: consumer( 'a', [ pt( 15, 30, 1500 ) ] ),
		r2: consumer( 'b', [ pt( 15, 60, 3000 ) ] ),
	} );
	expect( t.msgs ).toBe( 90 );
	expect( t.bytes ).toBe( 4500 );
} );

it( 'sums co-readers in separate workers whole, overlapping windows and all', () => {
	const t = probe24hTotals( {
		'request-builder.p0': consumer( 'firehose.p0', [
			pt( 15, 37, 1480 ),
			pt( 30, 37, 1480 ),
		] ),
		'flame-builder.p0': consumer( 'firehose.p0', [
			pt( 15.5, 53, 2120 ),
			pt( 30.5, 53, 2120 ),
		] ),
	} );
	expect( t.msgs ).toBe( 180 );
	expect( t.bytes ).toBe( 7200 );
} );

it( 'skips a reader that names no source, which no chart plots either', () => {
	const t = probe24hTotals( {
		r1: consumer( '', [ pt( 15, 30, 1500 ) ] ),
		r2: consumer( 'a', [ pt( 15, 7, 70 ) ] ),
	} );
	expect( t ).toEqual( { msgs: 7, bytes: 70 } );
} );

it( 'an idle interval contributes nothing', () => {
	const t = probe24hTotals( {
		r1: consumer( 's', [ pt( 0, 30, 1500 ), pt( 15, 0, 0 ) ] ),
	} );
	expect( t ).toEqual( { msgs: 30, bytes: 1500 } );
} );

it( 'an empty input totals zero', () => {
	expect( probe24hTotals( {} ) ).toEqual( { msgs: 0, bytes: 0 } );
	expect( probe24hTotals( null ) ).toEqual( { msgs: 0, bytes: 0 } );
} );

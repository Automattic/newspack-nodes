import { globalRates } from '../globalRates';

it( 'sums the read-rate map and the write-rate map independently', () => {
	const r = globalRates(
		{ 'firehose.p0': 1000, 'requests.p0': 500 },
		{ 'firehose.p0': 2000 }
	);
	expect( r ).toEqual( { readRate: 1500, writeRate: 2000 } );
} );

it( 'treats missing/empty maps as zero', () => {
	expect( globalRates( undefined, undefined ) ).toEqual( {
		readRate: 0,
		writeRate: 0,
	} );
	expect( globalRates( {}, {} ) ).toEqual( { readRate: 0, writeRate: 0 } );
} );

it( 'ignores non-numeric entries', () => {
	const r = globalRates( { a: 100, b: 'x', c: null }, { d: 50 } );
	expect( r ).toEqual( { readRate: 100, writeRate: 50 } );
} );

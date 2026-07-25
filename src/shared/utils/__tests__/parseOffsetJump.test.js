/**
 * parseOffsetJump — the offset-input grammar shared by every log-stream
 * dashboard: a full message ID (`seg:off:len`, length ignored) or a bare
 * offset resolved against the caller's fallback segment.
 */

import parseOffsetJump from '../parseOffsetJump';

it( 'parses a full message ID, ignoring the length', () => {
	expect( parseOffsetJump( '7:120:30', null ) ).toEqual( {
		segment: 7,
		offset: 120,
	} );
	expect( parseOffsetJump( '38:690928', 4 ) ).toEqual( {
		segment: 38,
		offset: 690928,
	} );
} );

it( 'resolves a bare offset against the fallback segment', () => {
	expect( parseOffsetJump( '4137', 6 ) ).toEqual( {
		segment: 6,
		offset: 4137,
	} );
	expect( parseOffsetJump( '4137', 0 ) ).toEqual( {
		segment: 0,
		offset: 4137,
	} );
} );

it( 'returns null for garbage or a bare offset with no fallback', () => {
	expect( parseOffsetJump( 'abc', 3 ) ).toBeNull();
	expect( parseOffsetJump( '', 3 ) ).toBeNull();
	expect( parseOffsetJump( '99', null ) ).toBeNull();
	expect( parseOffsetJump( '1:2:3:4', 3 ) ).toBeNull();
} );

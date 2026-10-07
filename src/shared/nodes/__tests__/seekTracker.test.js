/**
 * SeekTracker tests — the node-side seek/position tracker shared by the Partition
 * Viewer and the ELN Request/Error Log view nodes. It parses each
 * record's `segment:offset:length` ID breadcrumb, remembers the last-received
 * segment, and flips replay→live when a replayed record reaches the captured live
 * boundary. `track()` returns true ONLY when the received segment changed or the
 * mode flipped, so callers publish on change (no per-record storm).
 *
 * Values are deliberately distinct from every default (mode 'live',
 * lastReceivedSegment null, endSegment null): segments 98/105, offsets 500/1200.
 */

import { SeekTracker, browseControl, LIVE, REPLAY } from '../seekTracker';

describe( 'SeekTracker', () => {
	it( 'starts live with no received segment and no boundary', () => {
		const t = new SeekTracker();
		expect( t.mode ).toBe( 'live' );
		expect( t.lastReceivedSegment ).toBe( null );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'tracks the last-received segment from an ID breadcrumb and reports change', () => {
		const t = new SeekTracker();
		expect( t.track( '98:500:40' ) ).toBe( true );
		expect( t.lastReceivedSegment ).toBe( 98 );
	} );

	it( 'reports no change while the received segment is unchanged', () => {
		const t = new SeekTracker();
		t.track( '98:0:40' );
		expect( t.track( '98:40:40' ) ).toBe( false );
		expect( t.track( '98:80:40' ) ).toBe( false );
	} );

	it( 'browse() enters replay and captures the live boundary', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		expect( t.mode ).toBe( 'replay' );
		expect( t.endSegment ).toBe( 105 );
	} );

	it( 'flips to live and reports change when a record reaches the captured end', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		expect( t.track( '98:100:20' ) ).toBe( true ); // behind end segment
		expect( t.mode ).toBe( 'replay' );
		// 1160 + 40 = 1200 >= 1200 → caught up.
		expect( t.track( '105:1160:40' ) ).toBe( true );
		expect( t.mode ).toBe( 'live' );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'stays in replay until the captured end offset is reached', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		t.track( '105:100:20' ); // 120 < 1200
		expect( t.mode ).toBe( 'replay' );
	} );

	it( 'flips when a rotated segment exceeds the captured end (ordering fallback)', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		// A record from a NEWER segment 106 (> 105) rotated in during replay.
		expect( t.track( '106:0:10' ) ).toBe( true );
		expect( t.mode ).toBe( 'live' );
	} );

	it( 'browse() forgets the pre-seek received segment (highlight falls to the clicked one)', () => {
		const t = new SeekTracker();
		t.track( '98:500:40' ); // distinct from the null default
		t.browse( 105, 1200, [ 98, 105 ] );
		expect( t.lastReceivedSegment ).toBe( null );
	} );

	it( 'follow() returns to live and drops the boundary', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		t.follow();
		expect( t.mode ).toBe( 'live' );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'select() resets to live and clears the last-received segment', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		t.track( '98:0:20' );
		t.select();
		expect( t.mode ).toBe( 'live' );
		expect( t.lastReceivedSegment ).toBe( null );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'refuses a bounded browse that names no footprint', () => {
		const t = new SeekTracker();
		expect( () => t.browse( 105, 1200 ) ).toThrow( TypeError );
		expect( () => t.browse( 105, 1200, new Set( [ 98 ] ) ) ).toThrow(
			TypeError
		);
	} );

	it( 'a bare (null-end) browse never auto-flips', () => {
		const t = new SeekTracker();
		t.browse(); // no boundary to catch up to
		expect( t.mode ).toBe( 'replay' );
		expect( t.endSegment ).toBe( null );
		// Even a large opaque inode in the segment slot must not flip.
		t.track( '9999999:5000:40' );
		expect( t.mode ).toBe( 'replay' );
	} );

	it( 'a non-breadcrumb ID (command-reply / opaque hash) is ignored', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		expect( t.track( 'byckewr4dozme4rx5j1erloi1tjvmo29' ) ).toBe( false );
		expect( t.track( 123 ) ).toBe( false );
		expect( t.track( '' ) ).toBe( false );
		expect( t.lastReceivedSegment ).toBe( null );
		expect( t.mode ).toBe( 'replay' );
	} );
} );

/**
 * Catch-up by membership: ids are not ordered across a file's generations,
 * so a record from a segment outside the footprint captured at browse time
 * is live, whatever its number. Distinct values: partition segments 61/62/63
 * and newer 64; file inodes 7319 rotating DOWN to 2207, size 4410.
 */
describe( 'SeekTracker — catch-up against the captured footprint', () => {
	it( 'a partition: older captured segments stay replay, a newer one flips', () => {
		const t = new SeekTracker();
		t.browse( 63, 900, [ 61, 62, 63 ] );
		expect( t.track( '61:0:500' ) ).toBe( true );
		t.track( '62:0:500' );
		t.track( '63:0:100' );
		expect( t.mode ).toBe( REPLAY );
		expect( t.track( '64:0:10' ) ).toBe( true );
		expect( t.mode ).toBe( LIVE );
	} );

	it( 'a file whose inode rotates to a LOWER number flips', () => {
		const t = new SeekTracker();
		t.browse( 7319, 4410, [ 7319 ] );
		t.track( '7319:0:1200' );
		expect( t.mode ).toBe( REPLAY );
		expect( t.track( '2207:0:80' ) ).toBe( true );
		expect( t.mode ).toBe( LIVE );
	} );

	it( 'a file that reaches its captured size flips', () => {
		const t = new SeekTracker();
		t.browse( 7319, 4410, [ 7319 ] );
		t.track( '7319:0:4000' );
		expect( t.mode ).toBe( REPLAY );
		t.track( '7319:4000:410' );
		expect( t.mode ).toBe( LIVE );
	} );
} );

/**
 * The segmented boundary, exercised through the public surface — `endPosition`
 * is module-private now, because exporting half the deliverable is what let
 * three consumers build the other half three different ways.
 */
describe( 'the segmented boundary', () => {
	it( 'captures the newest segment id and its byte size as the live boundary', () => {
		expect(
			browseControl( {
				segments: [
					{ id: 97, size: 1000 },
					{ id: 105, size: 1200 },
				],
			} )
		).toEqual( {
			action: 'browse',
			endSegment: 105,
			endOffset: 1200,
			knownSegments: [ 97, 105 ],
		} );
	} );

	it( 'spans gaps and unordered input — newest id wins, not last listed', () => {
		expect(
			browseControl( {
				segments: [
					{ id: 105, size: 1200 },
					{ id: 98, size: 4000 },
				],
			} )
		).toEqual( {
			action: 'browse',
			endSegment: 105,
			endOffset: 1200,
			knownSegments: [ 105, 98 ],
		} );
	} );

	it( 'follows when no segment carries a numeric id', () => {
		expect( browseControl( { segments: [] } ) ).toEqual( {
			action: 'follow',
		} );
		expect( browseControl( { segments: [ { size: 10 } ] } ) ).toEqual( {
			action: 'follow',
		} );
	} );

	/**
	 * `endOffset` IS the catch-up test, so a boundary offset of 0 satisfies
	 * `offsetEnd >= 0` on the FIRST record of the end segment and would flip
	 * Replay→Live immediately, with no signal. The server always states a
	 * segment's size, so a missing one is a contract violation.
	 */
	it( 'throws on a segment with an id but no numeric size', () => {
		expect( () => browseControl( { segments: [ { id: 105 } ] } ) ).toThrow(
			TypeError
		);
	} );
} );

/**
 * The states are compared in four files and re-declared as literal defaults in
 * two more. The module that owns the state machine owns its vocabulary.
 */
describe( 'exported states', () => {
	it( 'exports the two mode values it compares internally', () => {
		expect( LIVE ).toBe( 'live' );
		expect( REPLAY ).toBe( 'replay' );
	} );
} );

/**
 * One cleared shape, not three: `follow()`, `select()` and the constructor
 * leave one cleared state.
 */
describe( 'reset paths agree', () => {
	const dirty = () => {
		const t = new SeekTracker();
		t.browse( 105, 1200, [ 98, 105 ] );
		t.track( '105:1000:50' );
		return t;
	};

	it( 'follow() clears the boundary offset too', () => {
		const t = dirty();
		t.follow();
		expect( t.endOffset ).toBe( 0 );
	} );

	it( 'select() clears everything the constructor does', () => {
		const t = dirty();
		t.select();
		expect( { ...t } ).toEqual( { ...new SeekTracker() } );
	} );

	it( 'the replay→live flip leaves the same shape as follow()', () => {
		const flipped = new SeekTracker();
		flipped.browse( 105, 1200, [ 98, 105 ] );
		flipped.track( '105:1150:50' ); // reaches the boundary → flips live
		const followed = new SeekTracker();
		followed.browse( 105, 1200, [ 98, 105 ] );
		followed.track( '105:100:10' );
		followed.follow();
		expect( flipped.mode ).toBe( LIVE );
		expect( { ...flipped, lastReceivedSegment: null } ).toEqual( {
			...followed,
			lastReceivedSegment: null,
		} );
	} );
} );

/**
 * The deliverable every consumer actually hands onward is the `browse` control
 * `LogStreamViewNode._control()` accepts — not a `{segment, offset}`. Producing
 * only half of it is why three call sites wrote the other half three ways, one
 * as an async re-fetch of data already in hand.
 */
describe( 'browseControl', () => {
	it( 'maps a segmented source to a browse on its newest segment', () => {
		expect(
			browseControl( {
				segments: [
					{ id: 98, size: 4000 },
					{ id: 105, size: 1200 },
				],
			} )
		).toEqual( {
			action: 'browse',
			endSegment: 105,
			endOffset: 1200,
			knownSegments: [ 98, 105 ],
		} );
	} );

	it( 'maps a file source, one segment, to a browse on its inode at its size', () => {
		expect(
			browseControl( { segments: [ { id: 4242, size: 8675309 } ] } )
		).toEqual( {
			action: 'browse',
			endSegment: 4242,
			endOffset: 8675309,
			knownSegments: [ 4242 ],
		} );
	} );

	it( 'maps an empty source to follow — there is no boundary to catch up to', () => {
		expect( browseControl( { segments: [] } ) ).toEqual( {
			action: 'follow',
		} );
	} );

	it( 'throws when the boundary segment carries no numeric size', () => {
		expect( () => browseControl( { segments: [ { id: 105 } ] } ) ).toThrow(
			/size/
		);
	} );
} );

/**
 * SeekTracker tests — the node-side seek/position tracker shared by the Partition
 * Viewer, Log Viewer, and the ELN Request/Error Log view nodes. It parses each
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
		t.browse( 105, 1200 );
		expect( t.mode ).toBe( 'replay' );
		expect( t.endSegment ).toBe( 105 );
	} );

	it( 'flips to live and reports change when a record reaches the captured end', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
		expect( t.track( '98:100:20' ) ).toBe( true ); // behind end segment
		expect( t.mode ).toBe( 'replay' );
		// 1160 + 40 = 1200 >= 1200 → caught up.
		expect( t.track( '105:1160:40' ) ).toBe( true );
		expect( t.mode ).toBe( 'live' );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'stays in replay until the captured end offset is reached', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
		t.track( '105:100:20' ); // 120 < 1200
		expect( t.mode ).toBe( 'replay' );
	} );

	it( 'flips when a rotated segment exceeds the captured end (ordering fallback)', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
		// A record from a NEWER segment 106 (> 105) rotated in during replay.
		expect( t.track( '106:0:10' ) ).toBe( true );
		expect( t.mode ).toBe( 'live' );
	} );

	it( 'browse() forgets the pre-seek received segment (highlight falls to the clicked one)', () => {
		const t = new SeekTracker();
		t.track( '98:500:40' ); // distinct from the null default
		t.browse( 105, 1200 );
		expect( t.lastReceivedSegment ).toBe( null );
	} );

	it( 'follow() returns to live and drops the boundary', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
		t.follow();
		expect( t.mode ).toBe( 'live' );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'select() resets to live and clears the last-received segment', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
		t.track( '98:0:20' );
		t.select();
		expect( t.mode ).toBe( 'live' );
		expect( t.lastReceivedSegment ).toBe( null );
		expect( t.endSegment ).toBe( null );
	} );

	it( 'a bare (null-end) browse never auto-flips (file-mode opaque-inode contract)', () => {
		const t = new SeekTracker();
		t.browse(); // no boundary — file mode has no orderable numeric end
		expect( t.mode ).toBe( 'replay' );
		expect( t.endSegment ).toBe( null );
		// Even a large opaque inode in the segment slot must not flip.
		t.track( '9999999:5000:40' );
		expect( t.mode ).toBe( 'replay' );
	} );

	it( 'a non-breadcrumb ID (command-reply / opaque hash) is ignored', () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
		expect( t.track( 'byckewr4dozme4rx5j1erloi1tjvmo29' ) ).toBe( false );
		expect( t.track( 123 ) ).toBe( false );
		expect( t.track( '' ) ).toBe( false );
		expect( t.lastReceivedSegment ).toBe( null );
		expect( t.mode ).toBe( 'replay' );
	} );
} );

// File mode: the segment slot is an opaque inode (no ordering). A null end WITH a
// positive byte size is a deterministic boundary — the first breadcrumb pins the
// reference generation; catch up by byte size on that inode, or flip on rotation.
// Distinct values: inode 4242, file size 977, rotation to inode 5151.
describe( 'SeekTracker — file mode (opaque inode + byte boundary)', () => {
	it( 'a null-end browse WITH a positive byte size enters file-mode replay', () => {
		const t = new SeekTracker();
		t.browse( null, 977 );
		expect( t.mode ).toBe( 'replay' );
	} );

	it( 'flips to live when a record on the reference inode reaches the byte size', () => {
		const t = new SeekTracker();
		t.browse( null, 977 );
		expect( t.track( '4242:0:500' ) ).toBe( true ); // pins inode 4242, 500<977
		expect( t.mode ).toBe( 'replay' );
		// 500 + 477 = 977 >= 977 → caught up to the seek-time file size.
		expect( t.track( '4242:500:477' ) ).toBe( true );
		expect( t.mode ).toBe( 'live' );
	} );

	it( 'stays in replay until the byte size is reached', () => {
		const t = new SeekTracker();
		t.browse( null, 977 );
		t.track( '4242:0:500' ); // 500 < 977
		expect( t.mode ).toBe( 'replay' );
	} );

	it( 'flips to live when the inode rotates (a different generation appeared)', () => {
		const t = new SeekTracker();
		t.browse( null, 977 );
		expect( t.track( '4242:0:500' ) ).toBe( true ); // pins inode 4242
		expect( t.mode ).toBe( 'replay' );
		// A new inode 5151 means logrotate happened — we're on the live edge.
		expect( t.track( '5151:0:100' ) ).toBe( true );
		expect( t.mode ).toBe( 'live' );
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
		).toEqual( { action: 'browse', endSegment: 105, endOffset: 1200 } );
	} );

	it( 'spans gaps and unordered input — newest id wins, not last listed', () => {
		expect(
			browseControl( {
				segments: [
					{ id: 105, size: 1200 },
					{ id: 98, size: 4000 },
				],
			} )
		).toEqual( { action: 'browse', endSegment: 105, endOffset: 1200 } );
	} );

	it( 'follows when no segment carries a numeric id and there are no bytes', () => {
		expect( browseControl( { segments: [] } ) ).toEqual( {
			action: 'follow',
		} );
		expect( browseControl( { segments: [ { size: 10 } ] } ) ).toEqual( {
			action: 'follow',
		} );
	} );

	/**
	 * Was "defaults a missing size to 0". Inverted deliberately: that default
	 * was silent and load-bearing. `endOffset` IS the catch-up test, so a
	 * boundary offset of 0 satisfies `offsetEnd >= 0` on the FIRST record of
	 * the end segment and flips Replay→Live immediately, with no signal. The
	 * server cannot produce the case — `class-log-sources.php:321` coerces
	 * `false === $size ? 0 : $size` before it goes on the wire — so the default
	 * only ever hid a contract violation.
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
 * One cleared shape, not three. `follow()` left `endOffset` behind while the
 * constructor zeroed it, so a tracker had two different "cleared" states — inert
 * only because `_caughtUp` is gated on `fileMode` and a non-null `endSegment`.
 */
describe( 'reset paths agree', () => {
	const dirty = () => {
		const t = new SeekTracker();
		t.browse( 105, 1200 );
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
		flipped.browse( 105, 1200 );
		flipped.track( '105:1150:50' ); // reaches the boundary → flips live
		const followed = new SeekTracker();
		followed.browse( 105, 1200 );
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
		).toEqual( { action: 'browse', endSegment: 105, endOffset: 1200 } );
	} );

	it( 'maps a file-mode source to a byte boundary with a null segment', () => {
		expect( browseControl( { segments: [], bytes: 8675309 } ) ).toEqual( {
			action: 'browse',
			endSegment: null,
			endOffset: 8675309,
		} );
	} );

	it( 'prefers a numeric segment id over a byte size when both are present', () => {
		expect(
			browseControl( {
				segments: [ { id: 105, size: 1200 } ],
				bytes: 8675309,
			} )
		).toEqual( { action: 'browse', endSegment: 105, endOffset: 1200 } );
	} );

	it( 'maps an empty source to follow — there is no boundary to catch up to', () => {
		expect( browseControl( { segments: [] } ) ).toEqual( {
			action: 'follow',
		} );
		expect( browseControl( { segments: [], bytes: 0 } ) ).toEqual( {
			action: 'follow',
		} );
	} );

	it( 'throws when the boundary segment carries no numeric size', () => {
		expect( () => browseControl( { segments: [ { id: 105 } ] } ) ).toThrow(
			/size/
		);
	} );
} );

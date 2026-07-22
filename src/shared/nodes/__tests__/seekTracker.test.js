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

import { SeekTracker, endPosition } from '../seekTracker';

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

describe( 'endPosition', () => {
	it( 'captures the newest segment id and its byte size as the live boundary', () => {
		expect(
			endPosition( [
				{ id: 97, size: 1000 },
				{ id: 105, size: 1200 },
			] )
		).toEqual( { segment: 105, offset: 1200 } );
	} );

	it( 'spans gaps and unordered input — newest id wins, not last listed', () => {
		expect(
			endPosition( [
				{ id: 105, size: 1200 },
				{ id: 98, size: 4000 },
			] )
		).toEqual( { segment: 105, offset: 1200 } );
	} );

	it( 'returns null when no segment carries a numeric id', () => {
		expect( endPosition( [] ) ).toBe( null );
		expect( endPosition( [ { size: 10 } ] ) ).toBe( null );
	} );

	it( 'defaults a missing size to 0', () => {
		expect( endPosition( [ { id: 105 } ] ) ).toEqual( {
			segment: 105,
			offset: 0,
		} );
	} );
} );

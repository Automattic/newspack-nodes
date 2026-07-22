/**
 * useLogPositions tests — the browse-model → SSE `positions` mapping shared by
 * the Partition Viewer (segments) and Log Viewer (sources). Live tails (null
 * positions → server 'end'); Browse opens a segment at offset 0; Replay seeks
 * 'start'; paging back walks to the previous existing segment id from log_status.
 */

import { renderHook, act } from '@testing-library/react';
import useLogPositions, {
	tailPositions,
	segmentPositions,
	replayPositions,
	previousSegmentId,
} from '../useLogPositions';

describe( 'pure position helpers', () => {
	it( 'tailPositions() is null so the server defaults to end (tail)', () => {
		expect( tailPositions() ).toBeNull();
	} );

	it( 'segmentPositions() opens a segment at offset 0, keyed by subscription', () => {
		expect( segmentPositions( 'firehose.p7', 3 ) ).toEqual( {
			'firehose.p7': { segment: 3, offset: 0 },
		} );
	} );

	it( 'replayPositions() seeks the magic start token', () => {
		expect( replayPositions( 'errors.p2' ) ).toEqual( {
			'errors.p2': 'start',
		} );
	} );

	it( 'previousSegmentId() returns the largest existing id below the current', () => {
		const segs = [ { id: 4 }, { id: 5 }, { id: 8 } ];
		expect( previousSegmentId( segs, 8 ) ).toBe( 5 );
		expect( previousSegmentId( segs, 5 ) ).toBe( 4 );
	} );

	it( 'previousSegmentId() spans retention gaps and floors at null', () => {
		const segs = [ { id: 4 }, { id: 8 } ];
		expect( previousSegmentId( segs, 8 ) ).toBe( 4 );
		expect( previousSegmentId( segs, 4 ) ).toBeNull();
		expect( previousSegmentId( [], 4 ) ).toBeNull();
		expect( previousSegmentId( segs, 'start' ) ).toBeNull();
	} );
} );

describe( 'useLogPositions', () => {
	it( 'starts live: mode "live", positions null', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		expect( result.current.mode ).toBe( 'live' );
		expect( result.current.positions ).toBeNull();
	} );

	it( 'browseSegment() opens that segment at offset 0', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		act( () => result.current.browseSegment( 6 ) );
		expect( result.current.mode ).toBe( 'browse' );
		expect( result.current.positions ).toEqual( {
			'firehose.p7': { segment: 6, offset: 0 },
		} );
	} );

	it( 'replay() seeks start; follow() returns to the live tail', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		act( () => result.current.replay() );
		expect( result.current.positions ).toEqual( {
			'firehose.p7': 'start',
		} );
		act( () => result.current.follow() );
		expect( result.current.mode ).toBe( 'live' );
		expect( result.current.positions ).toBeNull();
	} );

	it( 'pageBack() walks to the previous existing segment id', () => {
		const segs = [ { id: 4 }, { id: 5 }, { id: 8 } ];
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		act( () => result.current.browseSegment( 8 ) );
		act( () => result.current.pageBack( segs ) );
		expect( result.current.positions ).toEqual( {
			'firehose.p7': { segment: 5, offset: 0 },
		} );
	} );

	it( 'pageBack() at the oldest segment is a no-op', () => {
		const segs = [ { id: 4 }, { id: 5 } ];
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		act( () => result.current.browseSegment( 4 ) );
		act( () => result.current.pageBack( segs ) );
		expect( result.current.positions ).toEqual( {
			'firehose.p7': { segment: 4, offset: 0 },
		} );
	} );

	it( 'resets to the live tail when the subscription changes', () => {
		const { result, rerender } = renderHook(
			( { sub } ) => useLogPositions( sub ),
			{ initialProps: { sub: 'firehose.p7' } }
		);
		act( () => result.current.browseSegment( 6 ) );
		expect( result.current.mode ).toBe( 'browse' );
		rerender( { sub: 'errors.p2' } );
		expect( result.current.mode ).toBe( 'live' );
		expect( result.current.positions ).toBeNull();
	} );
} );

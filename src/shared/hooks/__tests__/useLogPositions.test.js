/**
 * useLogPositions tests — the browse-model → SSE `positions` mapping shared by
 * the Partition Viewer (segments) and Log Viewer (sources). Live tails (null
 * positions → server 'end'); Browse opens a segment at offset 0; Replay seeks
 * 'start'; paging back walks to the previous existing segment id from log_status.
 */

import { renderHook, act } from '@testing-library/react';
import useLogPositions, {
	segmentPositions,
	replayPositions,
	stepPosition,
} from '../useLogPositions';

describe( 'pure position helpers', () => {
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
} );

describe( 'useLogPositions', () => {
	it( 'starts at the live tail, with no clicked segment', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		expect( result.current.segmentId ).toBeNull();
	} );

	it( 'browseSegment() records the click and seeds that segment', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		let seed;
		act( () => {
			seed = result.current.browseSegment( 6 );
		} );
		expect( result.current.segmentId ).toBe( 6 );
		expect( seed ).toEqual( { 'firehose.p7': { segment: 6, offset: 0 } } );
	} );

	it( 'replay() seeds start; follow() seeds the tail', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p7' ) );
		let seed;
		act( () => {
			seed = result.current.replay();
		} );
		expect( seed ).toEqual( { 'firehose.p7': 'start' } );
		act( () => {
			seed = result.current.follow();
		} );
		expect( seed ).toBeNull();
		expect( result.current.segmentId ).toBeNull();
	} );

	it( 'resets to the live tail when the subscription changes', () => {
		const { result, rerender } = renderHook(
			( { sub } ) => useLogPositions( sub ),
			{ initialProps: { sub: 'firehose.p7' } }
		);
		act( () => result.current.browseSegment( 6 ) );
		expect( result.current.segmentId ).toBe( 6 );
		rerender( { sub: 'errors.p2' } );
		expect( result.current.segmentId ).toBeNull();
	} );

	it( 'seeds against the NEW subscription after a switch', () => {
		const { result, rerender } = renderHook(
			( { sub } ) => useLogPositions( sub ),
			{ initialProps: { sub: 'firehose.p7' } }
		);
		rerender( { sub: 'errors.p2' } );
		let seed;
		act( () => {
			seed = result.current.replay();
		} );
		expect( seed ).toEqual( { 'errors.p2': 'start' } );
	} );
} );

/**
 * The position a Step reads from. Replay seeks with the magic 'start' token, so
 * the cursor is a STRING there — the two step() implementations both required an
 * object and silently returned, which is why pause → Replay → Step did nothing.
 * One resolver now serves both.
 */
describe( 'stepPosition', () => {
	const link = ( resume ) => ( { resumePositions: () => resume } );

	it( 'passes a magic token through verbatim', () => {
		expect(
			stepPosition( link( null ), 'firehose.p0', {
				'firehose.p0': 'start',
			} )
		).toBe( 'start' );
	} );

	it( 'formats an explicit cursor as <segment>:<offset>', () => {
		expect(
			stepPosition( link( null ), 'firehose.p0', {
				'firehose.p0': { segment: 4, offset: 128 },
			} )
		).toBe( '4:128' );
	} );

	it( 'falls back to the live resume position with no pending seek', () => {
		expect(
			stepPosition(
				link( { 'firehose.p0': { segment: 7, offset: 42 } } ),
				'firehose.p0',
				null
			)
		).toBe( '7:42' );
	} );

	it( 'returns null when there is no cursor at all', () => {
		expect( stepPosition( link( null ), 'firehose.p0', null ) ).toBeNull();
	} );
} );

/**
 * The derived `positions` was the module's headline product and NO consumer
 * read it — structurally, not by oversight: `browseSegment( id )` calls
 * `setSegmentId`, so the new positions only exist on the NEXT render, while
 * every call site needs the seed in the SAME tick to hand to `seek()`. All
 * three therefore set the state, discarded its product, and recomputed the
 * identical object from the click argument.
 *
 * The actions now RETURN what they compute. `mode` went with it: it was a
 * second state machine over `SeekTracker.mode`'s concept with a divergent
 * vocabulary ('browse' vs 'replay'), and all three consumers display the
 * view's, not this one.
 */
describe( 'the actions return the seed they compute', () => {
	it( 'browseSegment returns that segment position', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		let seed;
		act( () => {
			seed = result.current.browseSegment( 7 );
		} );
		expect( seed ).toEqual( {
			'firehose.p0': { segment: 7, offset: 0 },
		} );
		expect( result.current.segmentId ).toBe( 7 );
	} );

	it( 'replay returns the start token', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		let seed;
		act( () => {
			seed = result.current.replay();
		} );
		expect( seed ).toEqual( { 'firehose.p0': 'start' } );
		expect( result.current.segmentId ).toBe( 'start' );
	} );

	it( 'follow returns null — the absent seek IS the tail', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		let seed;
		act( () => {
			seed = result.current.follow();
		} );
		expect( seed ).toBe( null );
		expect( result.current.segmentId ).toBe( null );
	} );

	it( 'no longer publishes a second mode, nor dead surface', () => {
		const { result } = renderHook( () => useLogPositions( 'firehose.p0' ) );
		expect( Object.keys( result.current ).sort() ).toEqual( [
			'browseSegment',
			'follow',
			'replay',
			'segmentId',
		] );
	} );
} );

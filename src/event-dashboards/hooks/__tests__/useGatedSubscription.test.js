/**
 * useGatedSubscription tests — the pause/visibility gating shared by the
 * Partition Viewer + Log Viewer hooks: a stream is open only while visible AND
 * unpaused; a control (select/seek) records the intended subscription and only
 * touches the live stream while active, and Play/refocus re-applies the recorded
 * target (never the old selection) — so changing the log or seeking WHILE PAUSED
 * can never revive the closed EventSource and burn a bounded server slot.
 *
 * `reopenSeed` (the reopen-positions decision) is pure and tested directly.
 */

import { renderHook, act } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useGatedSubscription, reopenSeed } from '../useGatedSubscription';

let mockPageVisible = true;
jest.mock( '@newspack-nodes/shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => mockPageVisible,
} ) );

function fakeLink( resume = null ) {
	return {
		setSubscribe: jest.fn(),
		close: jest.fn(),
		resumePositions: jest.fn( () => resume ),
	};
}

beforeEach( () => {
	mockPageVisible = true;
} );

function mount( link, view, fetchMessage ) {
	return renderHook( () => {
		const linkRef = useRef( link );
		const viewRef = useRef( view );
		return useGatedSubscription( { linkRef, viewRef, fetchMessage } );
	} );
}

describe( 'reopenSeed', () => {
	test( 'an explicit seek target wins over the resume offset', () => {
		const link = {
			resumePositions: () => ( { 'x.p0': { segment: 9, offset: 1 } } ),
		};
		expect(
			reopenSeed( link, {
				subscribe: [ 'x.p0' ],
				positions: { 'x.p0': { segment: 2, offset: 3 } },
			} )
		).toEqual( { 'x.p0': { segment: 2, offset: 3 } } );
	} );

	test( 'a live tail resumes the SAME dir from its last offset', () => {
		const link = {
			resumePositions: () => ( { 'x.p0': { segment: 5, offset: 7 } } ),
		};
		expect(
			reopenSeed( link, { subscribe: [ 'x.p0' ], positions: null } )
		).toEqual( { 'x.p0': { segment: 5, offset: 7 } } );
	} );

	test( 'a CHANGED dir has no resume point, so it tails (null)', () => {
		const link = {
			resumePositions: () => ( { 'x.p0': { segment: 5, offset: 7 } } ),
		};
		expect(
			reopenSeed( link, { subscribe: [ 'y.p0' ], positions: null } )
		).toBeNull();
	} );
} );

describe( 'useGatedSubscription', () => {
	test( 'resubscribe while active setSubscribes immediately', () => {
		const link = fakeLink();
		const { result } = mount( link, { fill: jest.fn() } );
		act( () => result.current.resubscribe( [ 'a' ], null ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a' ], null );
	} );

	test( 'resubscribe while paused only records; Play applies the recorded target', () => {
		const link = fakeLink();
		const { result } = mount( link, { fill: jest.fn() } );
		act( () => result.current.setPaused( true ) );
		link.setSubscribe.mockClear();
		// Changing selection while paused must NOT reopen the closed stream.
		act( () => result.current.resubscribe( [ 'b' ], null ) );
		expect( link.setSubscribe ).not.toHaveBeenCalled();
		// Play re-applies the recorded selection, not the old one.
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'b' ], null );
	} );

	test( 'an explicit seek is single-use: a LATER pause/play resumes live, not the stale seek', () => {
		// Mirrors Replay-then-catch-up-then-pause: the stream keeps tailing
		// live long after the seek was delivered (SeekTracker's Replay->Live
		// flip is a display-only signal — it never re-calls resubscribe), so
		// resumePositions() has since moved on to a live offset distinct from
		// the original replay target.
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const { result } = mount( link, { fill: jest.fn() } );

		act( () =>
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} )
		);
		expect( link.setSubscribe ).toHaveBeenLastCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 2, offset: 0 },
		} );
		link.setSubscribe.mockClear();

		act( () => result.current.setPaused( true ) );
		act( () => result.current.setPaused( false ) );

		expect( link.setSubscribe ).toHaveBeenLastCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 9, offset: 40 },
		} );
	} );

	// @longform The segment-click handlers pause AND seek in one synchronous
	// click. The pause gate must flip its refs immediately: waiting for the
	// React commit let the seek see "active", DELIVER to the closing stream,
	// and mark itself consumed — Step/Play then resumed the old live tail
	// (the "click a segment twice to rewind" bug).
	test( 'a seek in the same tick as pause records instead of delivering', () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const { result } = mount( link, { fill: jest.fn() } );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		// The closed stream never saw the seek…
		expect( link.setSubscribe ).not.toHaveBeenCalled();
		// …and Play opens exactly at the recorded seek, not the live resume.
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 2, offset: 0 },
		} );
	} );

	test( 'step after a same-tick pause+seek fetches the SEEK cursor', async () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const fetchMessage = jest.fn( () =>
			Promise.resolve( {
				message: [ 1, 'from', '', '0:0:9', '', 0, 'v' ],
				cursor: { segment: 2, offset: 9 },
			} )
		);
		const { result } = mount( link, { fill: jest.fn() }, fetchMessage );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		await act( async () => result.current.step() );
		// fetchMessage takes the formatted read position, not a cursor object.
		expect( fetchMessage ).toHaveBeenCalledWith( 'x.p0', '2:0' );
	} );

	/**
	 * Replay seeks the magic 'start' token, so the cursor is a STRING. The old
	 * object-only guard silently returned here — pause → Replay → Step did
	 * nothing until a segment click replaced the token with a {segment,offset}.
	 */
	test( 'steps from the magic start token a Replay seeks', async () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const fetchMessage = jest.fn( () =>
			Promise.resolve( {
				message: [ 1, 'from', '', '0:0:9', '', 0, 'v' ],
				cursor: { segment: 0, offset: 9 },
			} )
		);
		const { result } = mount( link, { fill: jest.fn() }, fetchMessage );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], { 'x.p0': 'start' } );
		} );
		await act( async () => result.current.step() );
		expect( fetchMessage ).toHaveBeenCalledWith( 'x.p0', 'start' );
	} );

	// @longform The symmetric hole: play flips the gate refs synchronously,
	// so a same-tick seek delivers immediately and is marked consumed — the
	// isActive effect must NOT then re-deliver the consumed target at the
	// live resume position, silently overwriting the seek it just applied.
	test( 'play + a same-tick seek delivers once, at the seek', () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const { result } = mount( link, { fill: jest.fn() } );
		act( () => result.current.setPaused( true ) );
		link.setSubscribe.mockClear();
		act( () => {
			result.current.setPaused( false );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		expect( link.setSubscribe ).toHaveBeenCalledTimes( 1 );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 2, offset: 0 },
		} );
	} );

	test( 'setPaused(true) closes the link and publishes the pause control', () => {
		const link = fakeLink();
		const view = { fill: jest.fn() };
		const { result } = mount( link, view );
		act( () => result.current.setPaused( true ) );
		expect( link.close ).toHaveBeenCalled();
		expect( view.fill ).toHaveBeenCalled();
	} );
} );

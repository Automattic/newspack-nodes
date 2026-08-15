/**
 * useGatedSubscription tests — the pause/visibility gating shared by the
 * Partition Viewer + Log Viewer hooks: a stream is open only while visible AND
 * unpaused; a control (select/seek) records the intended subscription and only
 * touches the live stream while active, and Play/refocus re-applies the recorded
 * target (never the old selection) — so changing the log or seeking WHILE PAUSED
 * can never revive the closed EventSource and burn a bounded server slot.
 *
 * The reopen-positions decision (explicit seek > same-dir resume > tail) is
 * asserted through what Play hands `setSubscribe`.
 */

import { renderHook, act } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useGatedSubscription } from '../useGatedSubscription';

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

// A view as the graph builds it: it declares the origin it trusts.
const fakeView = () => ( {
	name: 'x:view',
	controlFrom: 'x:view',
	fill: jest.fn(),
} );

function mount( link, view, requestStep, stepAnswer ) {
	return renderHook(
		( props ) => {
			const linkRef = useRef( link );
			const viewRef = useRef( view );
			return useGatedSubscription( {
				linkRef,
				viewRef,
				requestStep,
				stepAnswer: props?.stepAnswer,
			} );
		},
		{ initialProps: { stepAnswer } }
	);
}

describe( 'useGatedSubscription', () => {
	test( 'Play resumes the SAME dir from its recorded offset', () => {
		const link = fakeLink( { 'x.p0': { segment: 5, offset: 7 } } );
		const { result } = mount( link, fakeView() );
		act( () => result.current.resubscribe( [ 'x.p0' ], null ) );
		act( () => result.current.setPaused( true ) );
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 5, offset: 7 },
		} );
	} );

	test( 'Play tails a CHANGED dir — the old dir’s offset never applies', () => {
		const link = fakeLink( { 'x.p0': { segment: 5, offset: 7 } } );
		const { result } = mount( link, fakeView() );
		act( () => result.current.resubscribe( [ 'x.p0' ], null ) );
		act( () => result.current.setPaused( true ) );
		// Selecting another dir while paused only records the new target.
		act( () => result.current.resubscribe( [ 'y.p0' ], null ) );
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'y.p0' ], null );
	} );

	test( 'resubscribe while active setSubscribes immediately', () => {
		const link = fakeLink();
		const { result } = mount( link, fakeView() );
		act( () => result.current.resubscribe( [ 'a' ], null ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'a' ], null );
	} );

	test( 'resubscribe while paused only records; Play applies the recorded target', () => {
		const link = fakeLink();
		const { result } = mount( link, fakeView() );
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
		const { result } = mount( link, fakeView() );

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
		const { result } = mount( link, fakeView() );
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

	test( 'step after a same-tick pause+seek asks for the SEEK cursor', () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const requestStep = jest.fn();
		const { result } = mount( link, fakeView(), requestStep );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		act( () => result.current.step() );
		// requestStep takes the formatted read position, not a cursor object.
		expect( requestStep ).toHaveBeenCalledWith( 'x.p0', '2:0' );
	} );

	/**
	 * Replay seeks the magic 'start' token, so the cursor is a STRING. The old
	 * object-only guard silently returned here — pause → Replay → Step did
	 * nothing until a segment click replaced the token with a {segment,offset}.
	 */
	test( 'steps from the magic start token a Replay seeks', () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const requestStep = jest.fn();
		const { result } = mount( link, fakeView(), requestStep );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], { 'x.p0': 'start' } );
		} );
		act( () => result.current.step() );
		expect( requestStep ).toHaveBeenCalledWith( 'x.p0', 'start' );
	} );

	// The stepped record arrives later, on the node that asked; admitting it
	// is what advances the reopen target so the NEXT step continues from it.
	test( 'admits the stepped record and advances the reopen target', () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const view = fakeView();
		const requestStep = jest.fn();
		const { result, rerender } = mount( link, view, requestStep );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		act( () => result.current.step() );

		act( () =>
			rerender( {
				stepAnswer: {
					seq: 1,
					result: {
						message: [ 1, 'from', '', '0:0:9', '', 0, 'v' ],
						cursor: { segment: 2, offset: 9 },
					},
				},
			} )
		);

		expect( view.fill ).toHaveBeenCalled();
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 2, offset: 9 },
		} );
	} );

	// @longform The symmetric hole: play flips the gate refs synchronously,
	// so a same-tick seek delivers immediately and is marked consumed — the
	// isActive effect must NOT then re-deliver the consumed target at the
	// live resume position, silently overwriting the seek it just applied.
	test( 'play + a same-tick seek delivers once, at the seek', () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const { result } = mount( link, fakeView() );
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
		const view = fakeView();
		const { result } = mount( link, view );
		act( () => result.current.setPaused( true ) );
		expect( link.close ).toHaveBeenCalled();
		expect( view.fill ).toHaveBeenCalled();
	} );

	// A view with no controlFrom is a wiring bug. Minting the control anyway
	// sends a FROM that matches nothing: the belt never engages and nothing
	// says why, so the mistake has to surface here.
	test( 'a view declaring no controlFrom fails loud, not silently', () => {
		const { result } = mount( fakeLink( {} ), {
			name: 'x:view',
			fill: jest.fn(),
		} );
		expect( () => act( () => result.current.setPaused( true ) ) ).toThrow(
			/declares no controlFrom/
		);
	} );
} );

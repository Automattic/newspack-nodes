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

import { renderHook, act, waitFor } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useGatedSubscription } from '../useGatedSubscription';

let mockPageVisible = true;
jest.mock( '@newspack-nodes/shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => mockPageVisible,
} ) );

function fakeLink( resume = null ) {
	return {
		setSubscribe: jest.fn(),
		reconnect: jest.fn(),
		close: jest.fn(),
		cursor: jest.fn( ( sub ) => resume?.[ sub ] ),
	};
}

// The read the hook owns; `argsFor` is what each dashboard varies.
const STEP_READ = {
	ci: 'raw-logs',
	command: 'read_message',
	scope: 'gated:read',
	argsFor: ( sub, position ) => [ sub, position ],
	subOf: ( args ) => args[ 0 ],
};

let replyFor;

beforeEach( () => {
	mockPageVisible = true;
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => null );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

// Every read_message the fake wire was asked for, as [ sub, position ] pairs.
const stepArgs = () =>
	replyFor.mock.calls
		.map( ( [ m ] ) => m[ VALUE ] )
		.filter( ( v ) => 'read_message' === v?.name )
		.map( ( v ) => v.arguments );

// A view as the graph builds it: it declares the origin it trusts.
const fakeView = () => ( {
	name: 'x:view',
	controlFrom: 'x:view',
	fill: jest.fn(),
} );

function mount( link, view ) {
	return renderHook( () => {
		const linkRef = useRef( link );
		const viewRef = useRef( view );
		return useGatedSubscription( {
			linkRef,
			viewRef,
			stepRead: STEP_READ,
		} );
	} );
}

describe( 'useGatedSubscription', () => {
	// Play states no seek: the stream is the one that knows where it read to,
	// and asking it to reopen is how a stream that read NOTHING keeps the
	// replay it was opened with instead of being downgraded to a tail.
	test( 'Play reopens the SAME dir without restating a seek', () => {
		const link = fakeLink( { 'x.p0': { segment: 5, offset: 7 } } );
		const { result } = mount( link, fakeView() );
		act( () => result.current.resubscribe( [ 'x.p0' ], null ) );
		act( () => result.current.setPaused( true ) );
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.reconnect ).toHaveBeenCalledWith( [ 'x.p0' ] );
		expect( link.setSubscribe ).not.toHaveBeenCalled();
	} );

	test( 'Play re-points a CHANGED dir — the old dir’s offset never applies', () => {
		const link = fakeLink( { 'x.p0': { segment: 5, offset: 7 } } );
		const { result } = mount( link, fakeView() );
		act( () => result.current.resubscribe( [ 'x.p0' ], null ) );
		act( () => result.current.setPaused( true ) );
		// Selecting another dir while paused only records the new target.
		act( () => result.current.resubscribe( [ 'y.p0' ], null ) );
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.reconnect ).toHaveBeenCalledWith( [ 'y.p0' ] );
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
		expect( link.reconnect ).toHaveBeenCalledWith( [ 'b' ] );
	} );

	test( 'an explicit seek is single-use: a LATER pause/play resumes live, not the stale seek', () => {
		// Mirrors Replay-then-catch-up-then-pause: the stream keeps tailing
		// live long after the seek was delivered (SeekTracker's Replay->Live
		// flip is a display-only signal — it never re-calls resubscribe), so
		// the stream's own cursor has since moved on to a live offset distinct
		// from the original replay target.
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

		expect( link.reconnect ).toHaveBeenLastCalledWith( [ 'x.p0' ] );
		expect( link.setSubscribe ).not.toHaveBeenCalled();
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

	test( 'step after a same-tick pause+seek asks for the SEEK cursor', async () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const { result } = mount( link, fakeView() );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		act( () => result.current.step() );
		// The read takes the formatted position, not a cursor object.
		await waitFor(
			() => expect( stepArgs() ).toContainEqual( [ 'x.p0', '2:0' ] ),
			{ timeout: 4000 }
		);
	}, 20000 );

	/**
	 * Replay seeks the magic 'start' token, so the cursor is a STRING. The old
	 * object-only guard silently returned here — pause → Replay → Step did
	 * nothing until a segment click replaced the token with a {segment,offset}.
	 */
	test( 'steps from the magic start token a Replay seeks', async () => {
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const { result } = mount( link, fakeView() );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], { 'x.p0': 'start' } );
		} );
		act( () => result.current.step() );
		await waitFor(
			() => expect( stepArgs() ).toContainEqual( [ 'x.p0', 'start' ] ),
			{ timeout: 4000 }
		);
	}, 20000 );

	// The stepped record arrives later, on the node that asked; admitting it
	// is what advances the reopen target so the NEXT step continues from it.
	// @longform A verb with a SUB-VERB does not carry the source at args[0] —
	// `taillog read <sub> <pos>` puts the literal 'read' there. Reading the
	// reply's args positionally re-pointed the stream at a source called
	// 'read', which blanked the Log Viewer on the next Play. The partition
	// shape hides this, because there args[0] IS the source.
	test( 'advances the target using the SOURCE, not args[0], for a sub-verb', async () => {
		replyFor.mockImplementation( () => ( {
			message: [ 1, 'from', '', '0:0:9', '', 0, 'v' ],
			cursor: { segment: 2, offset: 9 },
		} ) );
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const view = fakeView();
		const { result } = renderHook( () => {
			const linkRef = useRef( link );
			const viewRef = useRef( view );
			return useGatedSubscription( {
				linkRef,
				viewRef,
				stepRead: {
					command: 'taillog',
					scope: 'gated:subverb',
					argsFor: ( sub, position ) => [ 'read', sub, position ],
					subOf: ( args ) => args[ 1 ],
				},
			} );
		} );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		act( () => result.current.step() );

		await waitFor( () => expect( view.fill ).toHaveBeenCalled(), {
			timeout: 4000,
		} );
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 2, offset: 9 },
		} );
	}, 20000 );

	test( 'admits the stepped record and advances the reopen target', async () => {
		replyFor.mockImplementation( () => ( {
			message: [ 1, 'from', '', '0:0:9', '', 0, 'v' ],
			cursor: { segment: 2, offset: 9 },
		} ) );
		const link = fakeLink( { 'x.p0': { segment: 9, offset: 40 } } );
		const view = fakeView();
		const { result } = mount( link, view );
		act( () => {
			result.current.setPaused( true );
			result.current.resubscribe( [ 'x.p0' ], {
				'x.p0': { segment: 2, offset: 0 },
			} );
		} );
		act( () => result.current.step() );

		await waitFor( () => expect( view.fill ).toHaveBeenCalled(), {
			timeout: 4000,
		} );
		link.setSubscribe.mockClear();
		act( () => result.current.setPaused( false ) );
		expect( link.setSubscribe ).toHaveBeenCalledWith( [ 'x.p0' ], {
			'x.p0': { segment: 2, offset: 9 },
		} );
	}, 20000 );

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

/**
 * TimeTravelPanel — a Consumer's keyframe ruler (one marker per offsetlog frame,
 * ordered by id, the SELECTED frame flagged current) plus a pause-gated transport
 * bar (rewind / pause / step / play / fast-forward). Reads node.frames from props
 * and tracks a CLIENT-SIDE position model: a `paused` flag, a `parkedFrameId`
 * (null = live/following-head) and a `steppedSincePark` flag. The live `cursor`
 * ({seg,off}) is informational only and does NOT drive selection — frame ids are
 * offsetlog segment ids, an independent number space from the source-partition
 * cursor seg. Each transport button calls onTransport( verb, positional ).
 */

import { render, fireEvent } from '@testing-library/react';
import TimeTravelPanel from '../TimeTravelPanel';

// Offsetlog-style frame ids (monotonic, climbed far past 0); the source cursor
// seg is an UNRELATED small number — the two spaces must NOT be conflated.
const FRAMES = [
	{ id: 8, size: 120 },
	{ id: 9, size: 40 },
	{ id: 10, size: 80 },
];
const CURSOR = { seg: 2, off: 12 };

const current = ( container ) =>
	container.querySelector( '.topology-tt__marker--current' )?.dataset.frameId;

const renderPanel = ( props = {} ) =>
	render(
		<TimeTravelPanel
			frames={ FRAMES }
			cursor={ CURSOR }
			onTransport={ jest.fn() }
			{ ...props }
		/>
	);

// Pause first, since every other button is gated behind `paused`.
const pause = ( view ) => fireEvent.click( view.getByLabelText( /pause/i ) );

describe( 'TimeTravelPanel — ruler & cursor', () => {
	it( 'renders one ruler marker per frame', () => {
		const { container } = renderPanel();
		expect(
			container.querySelectorAll( '.topology-tt__marker' )
		).toHaveLength( 3 );
	} );

	it( 'flags the NEWEST frame as current by default (selection, not cursor.seg)', () => {
		const { container } = renderPanel();
		const markers = container.querySelectorAll(
			'.topology-tt__marker--current'
		);
		expect( markers ).toHaveLength( 1 );
		// Newest frame id, NOT cursor.seg (2 isn't even a frame id).
		expect( markers[ 0 ].dataset.frameId ).toBe( '10' );
	} );

	it( 'keeps the newest frame current as new frames append (untouched = follow head)', () => {
		const { container, rerender } = renderPanel();
		expect( current( container ) ).toBe( '10' );
		rerender(
			<TimeTravelPanel
				frames={ [ ...FRAMES, { id: 11, size: 60 } ] }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
			/>
		);
		expect( current( container ) ).toBe( '11' );
	} );

	it( 'renders the empty state when there are zero frames', () => {
		const { container } = renderPanel( { frames: [], cursor: null } );
		expect(
			container.querySelectorAll( '.topology-tt__marker' )
		).toHaveLength( 0 );
		expect( container.textContent ).toMatch( /no keyframes yet/i );
	} );

	it( 'renders the cursor seg:off (informational)', () => {
		const { container } = renderPanel( { cursor: { seg: 2, off: 42 } } );
		expect( container.textContent ).toMatch( /2:42/ );
	} );

	it( 'does not render a state blob', () => {
		const { container } = renderPanel();
		expect( container.querySelector( '.topology-tt__state' ) ).toBeNull();
	} );
} );

describe( 'TimeTravelPanel — pause gating', () => {
	it( 'while live (not paused) ONLY pause is enabled', () => {
		const view = renderPanel();
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /^play/i ).disabled ).toBe( true );
	} );

	it( 'pause click disables pause and enables the rest (subject to edges)', () => {
		const view = renderPanel();
		pause( view );
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /^play/i ).disabled ).toBe( false );
		// Live + paused: rewind is enabled (it lands on the newest); fast-forward
		// stays disabled (nothing ahead of the head).
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
	} );

	it( 'pause sends bare PAUSE and play sends bare PLAY, flipping the gate', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		expect( onTransport ).toHaveBeenLastCalledWith( 'PAUSE', '' );
		fireEvent.click( view.getByLabelText( /^play/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'PLAY', '' );
		// Back to live: only pause enabled again.
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( true );
	} );

	it( 'disabled buttons do not fire onTransport while live', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		fireEvent.click( view.getByLabelText( /rewind/i ) );
		fireEvent.click( view.getByLabelText( /step/i ) );
		fireEvent.click( view.getByLabelText( /fast.?forward/i ) );
		fireEvent.click( view.getByLabelText( /^play/i ) );
		expect( onTransport ).not.toHaveBeenCalled();
	} );
} );

describe( 'TimeTravelPanel — step', () => {
	it( 'step sends bare STEP and keeps the panel paused', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /step/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'STEP', '' );
		// Still paused — step does not resume.
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( false );
	} );
} );

describe( 'TimeTravelPanel — snap-to-keyframe rewind/fast-forward', () => {
	// The worked example (10 = newest): live → pause → rewind ⇒ SEEK 10;
	// rewind ⇒ SEEK 9; step; rewind ⇒ SEEK 9 again (snap back, NOT 8);
	// rewind ⇒ SEEK 8.
	it( 'plays out the full worked example', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		const rewind = () =>
			fireEvent.click( view.getByLabelText( /rewind/i ) );

		rewind(); // live → land on the newest keyframe
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '10' );
		expect( current( view.container ) ).toBe( '10' );

		rewind(); // on 10, not stepped → previous keyframe
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );

		fireEvent.click( view.getByLabelText( /step/i ) ); // stepped past 9

		rewind(); // stepped → snap BACK to 9, not 8
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );

		rewind(); // on 9, not stepped → previous keyframe
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '8' );
		expect( current( view.container ) ).toBe( '8' );
	} );

	it( 'first rewind from live lands on the LAST keyframe (newest), not the one before', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '10' );
		expect( current( view.container ) ).toBe( '10' );
	} );

	it( 'fast-forward seeks the NEXT keyframe and clears the stepped flag', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 8 (oldest)
		fireEvent.click( view.getByLabelText( /fast.?forward/i ) ); // → 9
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );
	} );

	it( 'fast-forward after a step re-seeks the next keyframe (clears stepped)', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /step/i ) ); // stepped past 9
		fireEvent.click( view.getByLabelText( /fast.?forward/i ) ); // → 10
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '10' );
		expect( current( view.container ) ).toBe( '10' );
	} );

	it( 'disables rewind on the oldest keyframe (when not stepped)', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 8 (oldest)
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe(
			false
		);
	} );

	it( 're-enables rewind on the oldest keyframe after a step (snap back available)', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 8 (oldest)
		fireEvent.click( view.getByLabelText( /step/i ) ); // stepped past 8
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( false );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap back to 8
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '8' );
	} );

	it( 'disables fast-forward when live or parked on the newest', () => {
		const view = renderPanel();
		pause( view );
		// Live + paused: fast-forward disabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // park on newest 10
		// Parked on newest: still disabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		// Parked on a non-newest keyframe: enabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe(
			false
		);
	} );
} );

describe( 'TimeTravelPanel — play resumes following the head', () => {
	it( 'play un-parks, clears stepped, and follows the head again', () => {
		const onTransport = jest.fn();
		const { getByLabelText, container, rerender } = renderPanel( {
			onTransport,
		} );
		pause( { getByLabelText } );
		fireEvent.click( getByLabelText( /rewind/i ) ); // park on 10
		fireEvent.click( getByLabelText( /rewind/i ) ); // → 9
		expect( current( container ) ).toBe( '9' );
		fireEvent.click( getByLabelText( /^play/i ) ); // go live
		expect( onTransport ).toHaveBeenLastCalledWith( 'PLAY', '' );
		// A fresh checkpoint appends; current follows the head, not the parked id.
		rerender(
			<TimeTravelPanel
				frames={ [ ...FRAMES, { id: 11, size: 60 } ] }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		expect( current( container ) ).toBe( '11' );
	} );
} );

describe( 'TimeTravelPanel — clamp on aged-out park', () => {
	it( 'falls back to live (newest) when the parked frame ages out', () => {
		const onTransport = jest.fn();
		const { getByLabelText, container, rerender } = renderPanel( {
			onTransport,
		} );
		pause( { getByLabelText } );
		fireEvent.click( getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( getByLabelText( /rewind/i ) ); // → 9 (parked)
		// Retention drops 8/9/10 and rotates in newer frames; 9 no longer exists.
		const NEXT = [
			{ id: 12, size: 10 },
			{ id: 13, size: 20 },
		];
		rerender(
			<TimeTravelPanel
				frames={ NEXT }
				cursor={ { seg: 3, off: 0 } }
				onTransport={ onTransport }
			/>
		);
		expect( current( container ) ).toBe( '13' );
	} );
} );

describe( 'TimeTravelPanel — position feedback', () => {
	it( 'reports live, after the newest frame, when not parked or stepped', () => {
		const { container } = renderPanel();
		expect( container.textContent ).toMatch( /live/i );
		expect( container.textContent ).toMatch( /after frame 10/i );
	} );

	it( 'reports the parked keyframe when sitting on it', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		expect( view.container.textContent ).toMatch( /on frame 9/i );
	} );

	it( 'reports being between two keyframes after a step', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /step/i ) ); // between 9 and 10
		expect( view.container.textContent ).toMatch(
			/between frame 9 and 10/i
		);
	} );

	it( 'reports being after the parked keyframe when it is the newest and stepped', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10 (newest)
		fireEvent.click( view.getByLabelText( /step/i ) ); // stepped past 10
		expect( view.container.textContent ).toMatch( /after frame 10/i );
	} );

	it( 'reports stepping past the head when paused-live then stepped', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /step/i ) ); // stepped past the head
		expect( view.container.textContent ).toMatch(
			/stepped past frame 10/i
		);
	} );

	it( 'marks the current ruler marker --stepped when between keyframes', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		expect(
			view.container.querySelector( '.topology-tt__marker--stepped' )
		).toBeNull();
		fireEvent.click( view.getByLabelText( /step/i ) ); // between 9 and 10
		const stepped = view.container.querySelector(
			'.topology-tt__marker--stepped'
		);
		expect( stepped ).not.toBeNull();
		expect( stepped.dataset.frameId ).toBe( '9' );
	} );
} );

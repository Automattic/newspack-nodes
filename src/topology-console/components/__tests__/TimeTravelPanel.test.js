/**
 * TimeTravelPanel — a Consumer's keyframe ruler (one marker per offsetlog frame,
 * ordered by id, the SELECTED frame flagged current) plus a pause-gated transport
 * bar (rewind / pause / step / play / fast-forward). Reads node.frames from props
 * and tracks a position model SEEDED from / RECONCILED to two consumer-reported
 * signals: `atFrame` (the keyframe the cursor is at-or-just-past; null = no frames)
 * and `onFrame` (the cursor sits exactly on it vs advanced past it), plus the
 * `paused` gate. The live `cursor` ({segment,offset}) is informational only and does NOT
 * drive selection — frame ids are offsetlog segment ids, an independent number
 * space from the source-partition cursor segment. Each transport button calls
 * onTransport( verb, positional ).
 */

import { render, fireEvent } from '@testing-library/react';
import TimeTravelPanel from '../TimeTravelPanel';

// Offsetlog frame ids and the source cursor segment are UNRELATED spaces.
const FRAMES = [
	{ id: 8, size: 120 },
	{ id: 9, size: 40 },
	{ id: 10, size: 80 },
];
const CURSOR = { segment: 2, offset: 12 };

const current = ( container ) =>
	container.querySelector( '.topology-tt__marker--current' )?.dataset.frameId;

const stepped = ( container ) =>
	container.querySelector( '.topology-tt__marker--stepped' )?.dataset.frameId;

// Default props stand in for a live consumer: atFrame=newest, onFrame=false.
const renderPanel = ( props = {} ) =>
	render(
		<TimeTravelPanel
			frames={ FRAMES }
			cursor={ CURSOR }
			atFrameSignal={ 10 }
			onFrameSignal={ false }
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

	it( 'flags atFrame (the newest while live) as current — selection, not cursor.segment', () => {
		const { container } = renderPanel();
		const markers = container.querySelectorAll(
			'.topology-tt__marker--current'
		);
		expect( markers ).toHaveLength( 1 );
		// atFrame=10, NOT cursor.segment (2 isn't even a frame id).
		expect( markers[ 0 ].dataset.frameId ).toBe( '10' );
	} );

	it( 'follows the head: a new newest frame becomes atFrame via the signal', () => {
		const { container, rerender } = renderPanel();
		expect( current( container ) ).toBe( '10' );
		// Live: the next poll reports the new newest frame as atFrame.
		rerender(
			<TimeTravelPanel
				frames={ [ ...FRAMES, { id: 11, size: 60 } ] }
				cursor={ CURSOR }
				atFrameSignal={ 11 }
				onFrameSignal={ false }
				onTransport={ jest.fn() }
			/>
		);
		expect( current( container ) ).toBe( '11' );
	} );

	it( 'renders the empty state when there are zero frames', () => {
		const { container } = renderPanel( {
			frames: [],
			cursor: null,
			atFrameSignal: null,
		} );
		expect(
			container.querySelectorAll( '.topology-tt__marker' )
		).toHaveLength( 0 );
		expect( container.textContent ).toMatch( /no keyframes yet/i );
	} );

	it( 'renders the cursor segment:offset (informational)', () => {
		const { container } = renderPanel( {
			cursor: { segment: 2, offset: 42 },
		} );
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
		// Read-ahead: rewind snaps to keyframe; FF disabled (10 newest).
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
	// Worked example (10=newest): rewind snaps on-frame, then walks back.
	it( 'plays out the full worked example', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		const rewind = () =>
			fireEvent.click( view.getByLabelText( /rewind/i ) );

		rewind(); // read-ahead → snap onto the current keyframe 10
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '10' );
		expect( current( view.container ) ).toBe( '10' );

		rewind(); // on 10 → previous keyframe
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );

		fireEvent.click( view.getByLabelText( /step/i ) ); // off 9

		rewind(); // off-frame → snap BACK to 9, not 8
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );

		rewind(); // on 9 → previous keyframe
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '8' );
		expect( current( view.container ) ).toBe( '8' );
	} );

	it( 'first rewind from a read-ahead live consumer snaps onto atFrame (newest)', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '10' );
		expect( current( view.container ) ).toBe( '10' );
	} );

	it( 'a rewind from a quiet (on-frame) live consumer goes to the PREVIOUS keyframe', () => {
		// onFrame true ⇒ already on atFrame(10), so rewind steps back to 9.
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport, onFrameSignal: true } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );
	} );

	it( 'fast-forward seeks the NEXT keyframe and lands on it', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 8 (oldest)
		fireEvent.click( view.getByLabelText( /fast.?forward/i ) ); // → 9
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '9' );
		expect( current( view.container ) ).toBe( '9' );
	} );

	it( 'fast-forward after a step re-seeks the next keyframe (lands on-frame)', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /step/i ) ); // off 9
		fireEvent.click( view.getByLabelText( /fast.?forward/i ) ); // → 10
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '10' );
		expect( current( view.container ) ).toBe( '10' );
	} );

	it( 'disables rewind on the oldest keyframe (when on-frame)', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
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
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 8 (oldest)
		fireEvent.click( view.getByLabelText( /step/i ) ); // off 8
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( false );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap back to 8
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '8' );
	} );

	it( 'disables fast-forward when atFrame is the newest', () => {
		const view = renderPanel();
		pause( view );
		// Live (atFrame=10=newest): fast-forward disabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → newest 10
		// Still on the newest: disabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		// On a non-newest keyframe: enabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe(
			false
		);
	} );
} );

describe( 'TimeTravelPanel — play resumes following the head', () => {
	it( 'play fires PLAY and the next live signal follows the head', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport } );
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		expect( current( view.container ) ).toBe( '9' );
		fireEvent.click( view.getByLabelText( /^play/i ) ); // go live
		expect( onTransport ).toHaveBeenLastCalledWith( 'PLAY', '' );
		// A new checkpoint appends; the next live poll follows the head.
		view.rerender(
			<TimeTravelPanel
				frames={ [ ...FRAMES, { id: 11, size: 60 } ] }
				cursor={ CURSOR }
				atFrameSignal={ 11 }
				onFrameSignal={ false }
				paused={ false }
				onTransport={ onTransport }
			/>
		);
		expect( current( view.container ) ).toBe( '11' );
	} );
} );

describe( 'TimeTravelPanel — paused signal sync', () => {
	it( 'is paused on mount when the paused prop is true (rest enabled)', () => {
		const view = renderPanel( { paused: true, onFrameSignal: true } );
		// No client click needed: the signal alone gated the transport open.
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /^play/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( false );
	} );

	it( 'flips to live when the paused signal goes false', () => {
		const view = renderPanel( { paused: true } );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( false );
		// The consumer resumed elsewhere; the signal is the source of truth.
		view.rerender(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				atFrameSignal={ 10 }
				onFrameSignal={ false }
				onTransport={ jest.fn() }
				paused={ false }
			/>
		);
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( false );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( true );
	} );

	it( 'an optimistic PAUSE click enables the rest instantly, then a changed signal reconciles', () => {
		const onTransport = jest.fn();
		const view = renderPanel( { onTransport, paused: false } );
		// Click pauses instantly (optimistic), before the signal catches up.
		pause( view );
		expect( onTransport ).toHaveBeenLastCalledWith( 'PAUSE', '' );
		expect( view.getByLabelText( /step/i ).disabled ).toBe( false );
		// The signal arrives true: still paused, override deferred to it.
		view.rerender(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				atFrameSignal={ 10 }
				onFrameSignal={ false }
				onTransport={ onTransport }
				paused={ true }
			/>
		);
		expect( view.getByLabelText( /step/i ).disabled ).toBe( false );
		// Then the signal flips false (resumed): the panel reconciles to live.
		view.rerender(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				atFrameSignal={ 10 }
				onFrameSignal={ false }
				onTransport={ onTransport }
				paused={ false }
			/>
		);
		expect( view.getByLabelText( /step/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /pause/i ).disabled ).toBe( false );
	} );
} );

describe( 'TimeTravelPanel — position survives remount via signals', () => {
	it( 'seeds at_frame + off-frame position on mount (the remount case)', () => {
		// Fresh mount paused off frame 9: shows 9, --stepped, not live/newest.
		const { container } = renderPanel( {
			atFrameSignal: 9,
			onFrameSignal: false,
			paused: true,
		} );
		expect( current( container ) ).toBe( '9' );
		expect( stepped( container ) ).toBe( '9' );
		expect( container.textContent ).toMatch( /between frame 9 and 10/i );
	} );

	it( 'seeds at-frame on-keyframe on mount', () => {
		const { container } = renderPanel( {
			atFrameSignal: 9,
			onFrameSignal: true,
			paused: true,
		} );
		expect( current( container ) ).toBe( '9' );
		expect( stepped( container ) ).toBeUndefined();
		expect( container.textContent ).toMatch( /on frame 9/i );
	} );

	it( 'seeds a quiet live consumer reading "on frame N" (the goal)', () => {
		// Live + quiet (onFrame true): reads "on frame 10", not "after".
		const { container } = renderPanel( {
			atFrameSignal: 10,
			onFrameSignal: true,
			paused: false,
		} );
		expect( current( container ) ).toBe( '10' );
		expect( container.textContent ).toMatch( /on frame 10/i );
		expect( container.textContent ).not.toMatch( /after frame/i );
	} );

	it( 'reconciles to a changed at_frame signal from the next poll', () => {
		const view = renderPanel( {
			atFrameSignal: 9,
			onFrameSignal: true,
			paused: true,
		} );
		expect( current( view.container ) ).toBe( '9' );
		// The next poll reports the consumer at the older frame 8 instead.
		view.rerender(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
				paused={ true }
				atFrameSignal={ 8 }
				onFrameSignal={ true }
			/>
		);
		expect( current( view.container ) ).toBe( '8' );
	} );

	it( 'reconciles to a changed on_frame signal', () => {
		const view = renderPanel( {
			atFrameSignal: 9,
			onFrameSignal: true,
			paused: true,
		} );
		expect(
			view.container.querySelector( '.topology-tt__marker--stepped' )
		).toBeNull();
		view.rerender(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
				paused={ true }
				atFrameSignal={ 9 }
				onFrameSignal={ false }
			/>
		);
		expect( stepped( view.container ) ).toBe( '9' );
	} );

	it( 'a transport click still drives optimistically before the signal catches up', () => {
		// Mounted on frame 9; rewind moves to 8 AT ONCE, before the next poll.
		const onTransport = jest.fn();
		const view = renderPanel( {
			onTransport,
			atFrameSignal: 9,
			onFrameSignal: true,
			paused: true,
		} );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // on 9 → 8
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '8' );
		expect( current( view.container ) ).toBe( '8' );
	} );
} );

describe( 'TimeTravelPanel — clamp on aged-out at_frame', () => {
	it( 'falls back to the newest frame when atFrame ages out of the window', () => {
		const onTransport = jest.fn();
		const view = renderPanel( {
			onTransport,
			atFrameSignal: 9,
			onFrameSignal: true,
			paused: true,
		} );
		expect( current( view.container ) ).toBe( '9' );
		// Retention drops 8/9/10 and rotates in newer frames; 9 is gone.
		const NEXT = [
			{ id: 12, size: 10 },
			{ id: 13, size: 20 },
		];
		view.rerender(
			<TimeTravelPanel
				frames={ NEXT }
				cursor={ { segment: 3, offset: 0 } }
				atFrameSignal={ 9 }
				onFrameSignal={ true }
				paused={ true }
				onTransport={ onTransport }
			/>
		);
		expect( current( view.container ) ).toBe( '13' );
	} );
} );

describe( 'TimeTravelPanel — position feedback', () => {
	it( 'reports "after frame N" when live and reading ahead (not on the frame)', () => {
		const { container } = renderPanel(); // atFrame=10, onFrame false, live.
		expect( container.textContent ).toMatch( /after frame 10/i );
	} );

	it( 'reports the keyframe when sitting on it', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		expect( view.container.textContent ).toMatch( /on frame 9/i );
	} );

	it( 'reports being between two keyframes after a step', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		fireEvent.click( view.getByLabelText( /step/i ) ); // between 9 and 10
		expect( view.container.textContent ).toMatch(
			/between frame 9 and 10/i
		);
	} );

	it( 'reports being after the keyframe when it is the newest and stepped off', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10 newest
		fireEvent.click( view.getByLabelText( /step/i ) ); // off 10
		expect( view.container.textContent ).toMatch( /after frame 10/i );
	} );

	it( 'marks the current ruler marker --stepped when off the keyframe', () => {
		const view = renderPanel();
		pause( view );
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // snap → 10
		fireEvent.click( view.getByLabelText( /rewind/i ) ); // → 9
		expect(
			view.container.querySelector( '.topology-tt__marker--stepped' )
		).toBeNull();
		fireEvent.click( view.getByLabelText( /step/i ) ); // off 9
		const cue = view.container.querySelector(
			'.topology-tt__marker--stepped'
		);
		expect( cue ).not.toBeNull();
		expect( cue.dataset.frameId ).toBe( '9' );
	} );
} );

/**
 * TimeTravelPanel — a Consumer's keyframe ruler (one marker per offsetlog frame,
 * ordered by id, the SELECTED frame flagged current) plus the transport bar
 * (rewind / pause / step / play / fast-forward). Reads node.frames from props
 * and tracks a CLIENT-SIDE selected frame (defaulting to the newest); the live
 * `cursor` ({seg,off}) is informational only and does NOT drive selection —
 * frame ids are offsetlog segment ids, an independent number space from the
 * source-partition cursor seg. Each transport button calls onTransport( verb,
 * positional ).
 */

import { render, fireEvent } from '@testing-library/react';
import TimeTravelPanel from '../TimeTravelPanel';

// Offsetlog-style frame ids (monotonic, climbed far past 0); the source cursor
// seg is an UNRELATED small number — the two spaces must NOT be conflated.
const FRAMES = [
	{ id: 5342, size: 120 },
	{ id: 5343, size: 40 },
	{ id: 5344, size: 80 },
];
const CURSOR = { seg: 2, off: 12 };

describe( 'TimeTravelPanel', () => {
	it( 'renders one ruler marker per frame', () => {
		const { container } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-tt__marker' )
		).toHaveLength( 3 );
	} );

	it( 'flags the NEWEST frame as current by default (selection, not cursor.seg)', () => {
		const { container } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
			/>
		);
		const current = container.querySelectorAll(
			'.topology-tt__marker--current'
		);
		expect( current ).toHaveLength( 1 );
		// Newest frame id, NOT cursor.seg (2 isn't even a frame id).
		expect( current[ 0 ].dataset.frameId ).toBe( '5344' );
	} );

	it( 'keeps the newest frame current as new frames append (untouched = follow head)', () => {
		const { container, rerender } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
			/>
		);
		expect(
			container.querySelector( '.topology-tt__marker--current' ).dataset
				.frameId
		).toBe( '5344' );
		// A new checkpoint appends a newer frame; with no transport interaction
		// the current marker must FOLLOW the head, not stick on the
		// selection-time newest (the reported bug).
		rerender(
			<TimeTravelPanel
				frames={ [ ...FRAMES, { id: 5345, size: 60 } ] }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
			/>
		);
		expect(
			container.querySelector( '.topology-tt__marker--current' ).dataset
				.frameId
		).toBe( '5345' );
	} );

	it( 'PLAY resumes following the head (un-pins a rewound selection)', () => {
		const onTransport = jest.fn();
		const { getByLabelText, container, rerender } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		fireEvent.click( getByLabelText( /rewind/i ) ); // park on 5343
		expect(
			container.querySelector( '.topology-tt__marker--current' ).dataset
				.frameId
		).toBe( '5343' );
		fireEvent.click( getByLabelText( /^play/i ) ); // go live → un-pin
		// A fresh checkpoint appends; current must follow the head, not stay parked.
		rerender(
			<TimeTravelPanel
				frames={ [ ...FRAMES, { id: 5345, size: 60 } ] }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		expect(
			container.querySelector( '.topology-tt__marker--current' ).dataset
				.frameId
		).toBe( '5345' );
	} );

	it( 'renders the empty state when there are zero frames', () => {
		const { container } = render(
			<TimeTravelPanel
				frames={ [] }
				cursor={ null }
				onTransport={ jest.fn() }
			/>
		);
		expect(
			container.querySelectorAll( '.topology-tt__marker' )
		).toHaveLength( 0 );
		expect( container.textContent ).toMatch( /no keyframes yet/i );
	} );

	it( 'renders the cursor seg:off (informational)', () => {
		const { container } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ { seg: 2, off: 42 } }
				onTransport={ jest.fn() }
			/>
		);
		expect( container.textContent ).toMatch( /2:42/ );
	} );

	it( 'pause / play / step send the bare verb with no args', () => {
		const onTransport = jest.fn();
		const { getByLabelText } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		fireEvent.click( getByLabelText( /pause/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'PAUSE', '' );
		fireEvent.click( getByLabelText( /^play/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'PLAY', '' );
		fireEvent.click( getByLabelText( /step/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'STEP', '' );
	} );

	it( 'rewind seeks the PREVIOUS frame id by selection and advances the selection', () => {
		const onTransport = jest.fn();
		const { getByLabelText, container } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		// Default selection is the newest (5344); rewind → previous id 5343.
		fireEvent.click( getByLabelText( /rewind/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '5343' );
		// The current marker tracks the new selection.
		expect(
			container.querySelector( '.topology-tt__marker--current' ).dataset
				.frameId
		).toBe( '5343' );
		// Rewind again → 5342 (the oldest).
		fireEvent.click( getByLabelText( /rewind/i ) );
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '5342' );
	} );

	it( 'fast-forward seeks the NEXT frame id by selection after a rewind', () => {
		const onTransport = jest.fn();
		const { getByLabelText } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		// Default selection is the newest, so step back twice to the oldest.
		fireEvent.click( getByLabelText( /rewind/i ) ); // → 5343
		fireEvent.click( getByLabelText( /rewind/i ) ); // → 5342
		fireEvent.click( getByLabelText( /fast.?forward/i ) ); // → 5343
		expect( onTransport ).toHaveBeenLastCalledWith( 'SEEK_FRAME', '5343' );
	} );

	it( 'disables rewind at the oldest selection and fast-forward at the newest', () => {
		const onTransport = jest.fn();
		const view = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		// Default selection = newest: fast-forward disabled, rewind enabled.
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( false );
		// Rewind twice to the oldest: rewind disabled, fast-forward enabled.
		fireEvent.click( view.getByLabelText( /rewind/i ) );
		fireEvent.click( view.getByLabelText( /rewind/i ) );
		expect( view.getByLabelText( /rewind/i ).disabled ).toBe( true );
		expect( view.getByLabelText( /fast.?forward/i ).disabled ).toBe(
			false
		);
	} );

	it( 'clamps the selection to the newest when node.frames changes and drops it', () => {
		const onTransport = jest.fn();
		const { getByLabelText, container, rerender } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ onTransport }
			/>
		);
		// Select an older frame.
		fireEvent.click( getByLabelText( /rewind/i ) ); // selected = 5343
		// New frames after play/truncation no longer contain 5343 → reset to newest.
		const NEXT = [
			{ id: 5345, size: 10 },
			{ id: 5346, size: 20 },
		];
		rerender(
			<TimeTravelPanel
				frames={ NEXT }
				cursor={ { seg: 3, off: 0 } }
				onTransport={ onTransport }
			/>
		);
		expect(
			container.querySelector( '.topology-tt__marker--current' ).dataset
				.frameId
		).toBe( '5346' );
	} );

	it( 'does not render a state blob', () => {
		const { container } = render(
			<TimeTravelPanel
				frames={ FRAMES }
				cursor={ CURSOR }
				onTransport={ jest.fn() }
			/>
		);
		expect( container.querySelector( '.topology-tt__state' ) ).toBeNull();
	} );
} );

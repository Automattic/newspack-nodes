/**
 * SegmentBar — the three-region segment fill: green processed (0→cursor), the
 * backlog the consumer knows about but hasn't read (cursor→recorded probe end),
 * and a gray "beyond" region for live bytes past the recorded end (recorded
 * end→live head). The backlog is ONE color: YELLOW when the lag stays within the
 * segment the cursor is in (green→yellow→gray), RED when it spans a segment
 * boundary (green→red→gray, a bigger fall-behind). A segment in a tree with no
 * consumer of the log (cursorSegment null) renders entirely gray.
 *
 * The regions arrive as props, computed once per bar by `segmentRegions`, so
 * each case here renders the bar from that one computation. Motion arrives as
 * props too: `stagger` counts the fill transition's delay in steps, and
 * `snap` draws the final widths at once.
 */

import { render, fireEvent, createEvent } from '@testing-library/react';
import { SegmentBar, segmentRegions } from '../SegmentBar';

/**
 * The bar for one segment under one reader position, its regions computed
 * the way `LogRows` computes them.
 *
 * @param {Object} props               Everything else the bar takes.
 * @param {Object} props.segment       The segment.
 * @param {number} props.cursorSegment Reader cursor segment id.
 * @param {number} props.cursorOffset  Reader cursor offset.
 * @param {number} props.endSegment    Recorded end segment id.
 * @param {number} props.endSize       Recorded end offset.
 * @return {import('react').ReactElement} The bar.
 */
function Bar( {
	segment,
	cursorSegment,
	cursorOffset,
	endSegment,
	endSize,
	...props
} ) {
	return (
		<SegmentBar
			segment={ segment }
			{ ...segmentRegions(
				segment,
				null === cursorSegment
					? undefined
					: {
							segment: cursorSegment,
							offset: cursorOffset,
							endSegment,
							endSize,
					  }
			) }
			{ ...props }
		/>
	);
}

/**
 * Fire `animationend` naming the animation; jsdom has no AnimationEvent, so
 * the name is stamped onto the generic event React reads it from.
 *
 * @param {Element} el   The animated element.
 * @param {string}  name The `animation-name` that ended.
 */
function endAnimation( el, name ) {
	const event = createEvent.animationEnd( el );
	Object.defineProperty( event, 'animationName', { value: name } );
	fireEvent( el, event );
}

// Pull the three fills out in DOM order, as { className, width }.
function fills( container ) {
	return [ ...container.querySelectorAll( '.segment-fill-h' ) ].map(
		( el ) => ( {
			className: el.getAttribute( 'class' ),
			width: el.style.width,
		} )
	);
}

describe( 'SegmentBar — three regions', () => {
	it( 'a lag within the current segment is green → YELLOW → gray', () => {
		// cursor at 40, recorded end at 80, live head at 100 — all in seg 0.
		const { container } = render(
			<Bar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSegment={ 0 }
				cursorOffset={ 40 }
				endSegment={ 0 }
				endSize={ 80 }
			/>
		);
		const f = fills( container );
		expect( f ).toHaveLength( 3 );
		expect( f[ 0 ].className ).toContain( 'processed' );
		expect( f[ 0 ].width ).toBe( '40%' );
		// Backlog (40→80) is yellow — the lag never leaves this segment.
		expect( f[ 1 ].className ).toContain( 'pending' );
		expect( f[ 1 ].width ).toBe( '40%' );
		// Beyond (80→100) gray.
		expect( f[ 2 ].className ).toContain( 'beyond' );
		expect( f[ 2 ].width ).toBe( '20%' );
	} );

	it( 'a stale recorded end (within the segment) is yellow backlog + a gray tail', () => {
		const { container } = render(
			<Bar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSegment={ 0 }
				cursorOffset={ 20 }
				endSegment={ 0 }
				endSize={ 60 }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].width ).toBe( '20%' );
		// yellow, within-segment lag
		expect( f[ 1 ].className ).toContain( 'pending' );
		expect( f[ 1 ].width ).toBe( '40%' );
		expect( f[ 2 ].className ).toContain( 'beyond' );
		expect( f[ 2 ].width ).toBe( '40%' );
	} );

	it( 'no consumer (cursorSegment null) renders the whole segment gray', () => {
		const { container } = render(
			<Bar
				segment={ { id: 0, size: 80 } }
				maxSize={ 100 }
				cursorSegment={ null }
				cursorOffset={ null }
				endSegment={ null }
				endSize={ null }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].width ).toBe( '0%' ); // processed
		expect( f[ 1 ].width ).toBe( '0%' ); // backlog
		expect( f[ 2 ].className ).toContain( 'beyond' );
		expect( f[ 2 ].width ).toBe( '80%' );
	} );

	it( 'a lag that spans a segment boundary is RED (no yellow), across every segment it covers', () => {
		// cursor in segment 0 at 40; recorded end is in segment 1 (at 50).
		const lag = {
			cursorSegment: 0,
			cursorOffset: 40,
			endSegment: 1,
			endSize: 50,
		};
		// Segment 0: green read + RED remainder (lag into seg 1), no gray.
		const seg0 = fills(
			render(
				<Bar
					segment={ { id: 0, size: 100 } }
					maxSize={ 100 }
					{ ...lag }
				/>
			).container
		);
		expect( seg0[ 0 ].width ).toBe( '40%' ); // green
		// RED, not pending
		expect( seg0[ 1 ].className ).toBe( 'segment-fill-h ' );
		expect( seg0[ 1 ].width ).toBe( '60%' );
		expect( seg0[ 2 ].width ).toBe( '0%' );
		// Segment 1 (ahead): red backlog up to the recorded end, gray beyond.
		const seg1 = fills(
			render(
				<Bar
					segment={ { id: 1, size: 100 } }
					maxSize={ 100 }
					{ ...lag }
				/>
			).container
		);
		expect( seg1[ 1 ].className ).toBe( 'segment-fill-h ' ); // RED
		expect( seg1[ 1 ].width ).toBe( '50%' );
		expect( seg1[ 2 ].className ).toContain( 'beyond' );
		expect( seg1[ 2 ].width ).toBe( '50%' );
	} );

	it( 'hands the stylesheet its stagger as a step count', () => {
		// Two bars after the row's first change: the stylesheet times each step.
		const { container } = render(
			<Bar
				segment={ { id: 4473, size: 100 } }
				maxSize={ 100 }
				cursorSegment={ 4473 }
				cursorOffset={ 50 }
				endSegment={ 4473 }
				endSize={ 100 }
				stagger={ 2 }
			/>
		);
		const bar = container.querySelector( '.worker-segment-h' );
		expect( bar.style.getPropertyValue( '--seg-stagger' ) ).toBe( '2' );
	} );

	it( 'a snapped bar draws its final widths even when it just arrived', () => {
		const { container } = render(
			<Bar
				segment={ { id: 4474, size: 7340032 } }
				maxSize={ 8388608 }
				cursorSegment={ 4475 }
				cursorOffset={ 0 }
				endSegment={ 4475 }
				endSize={ 0 }
				isNew={ true }
				snap={ true }
			/>
		);
		const bar = container.querySelector( '.worker-segment-h' );
		expect( bar.className ).toContain( 'segment-snap' );
		expect( fills( container )[ 0 ].width ).toBe( '87.5%' );
	} );

	it( 'a departing bar reports its own slide-out ending, and nothing else', () => {
		const onSlidOut = jest.fn();
		const { container } = render(
			<Bar
				segment={ { id: 4471, size: 8388608 } }
				maxSize={ 8388608 }
				cursorSegment={ 4479 }
				cursorOffset={ 0 }
				endSegment={ 4479 }
				endSize={ 0 }
				isRemoving={ true }
				onSlidOut={ onSlidOut }
			/>
		);
		const bar = container.querySelector( '.worker-segment-h' );
		endAnimation( bar, 'segment-slide-in' );
		expect( onSlidOut ).not.toHaveBeenCalled();
		endAnimation( bar, 'segment-slide-out' );
		expect( onSlidOut ).toHaveBeenCalledWith( 4471 );
	} );

	it( 'a newly-arrived segment (isNew) mounts with empty fills so they animate in', () => {
		// CSS transitions skip mount; render 0-width first, then real widths.
		const { container } = render(
			<Bar
				segment={ { id: 3, size: 100 } }
				maxSize={ 100 }
				cursorSegment={ 3 }
				cursorOffset={ 40 }
				endSegment={ 3 }
				endSize={ 80 }
				isNew={ true }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].width ).toBe( '0%' );
		expect( f[ 1 ].width ).toBe( '0%' );
		expect( f[ 2 ].width ).toBe( '0%' );
	} );

	it( 'titles the bar with the numeric segment id and the formatted size', () => {
		const { container } = render(
			<Bar
				segment={ { id: 47, size: 2048 } }
				maxSize={ 4096 }
				cursorSegment={ 47 }
				cursorOffset={ 512 }
				endSegment={ 47 }
				endSize={ 1024 }
			/>
		);
		expect(
			container
				.querySelector( '.worker-segment-h' )
				.getAttribute( 'title' )
		).toBe( 'Segment 47: 2 KB' );
	} );

	it( 'a fully-read older segment is all green (read past it)', () => {
		const { container } = render(
			<Bar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSegment={ 1 }
				cursorOffset={ 10 }
				endSegment={ 1 }
				endSize={ 50 }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].className ).toContain( 'processed' );
		expect( f[ 0 ].width ).toBe( '100%' );
		expect( f[ 1 ].width ).toBe( '0%' );
		expect( f[ 2 ].width ).toBe( '0%' );
	} );
} );

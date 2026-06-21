/**
 * SegmentBar — the three-region segment fill: green processed (0→cursor), the
 * backlog the consumer knows about but hasn't read (cursor→recorded probe end),
 * and a gray "beyond" region for live bytes past the recorded end (recorded
 * end→live head). The backlog is ONE color: YELLOW when the lag stays within the
 * segment the cursor is in (green→yellow→gray), RED when it spans a segment
 * boundary (green→red→gray, a bigger fall-behind). A segment in a tree with no
 * consumer of the log (cursorSeg null) renders entirely gray.
 */

import { render } from '@testing-library/react';
import { SegmentBar } from '../SegmentBar';

// Pull the three fills out of the rendered bar in DOM order, as { className, width }.
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
		// cursor at 40, recorded end at 80, live head at 100 — all in segment 0.
		const { container } = render(
			<SegmentBar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 0 }
				cursorOffset={ 40 }
				endSeg={ 0 }
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
			<SegmentBar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 0 }
				cursorOffset={ 20 }
				endSeg={ 0 }
				endSize={ 60 }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].width ).toBe( '20%' );
		expect( f[ 1 ].className ).toContain( 'pending' ); // yellow, within-segment lag
		expect( f[ 1 ].width ).toBe( '40%' );
		expect( f[ 2 ].className ).toContain( 'beyond' );
		expect( f[ 2 ].width ).toBe( '40%' );
	} );

	it( 'no consumer (cursorSeg null) renders the whole segment gray', () => {
		const { container } = render(
			<SegmentBar
				segment={ { id: 0, size: 80 } }
				maxSize={ 100 }
				cursorSeg={ null }
				cursorOffset={ null }
				endSeg={ null }
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
		const lag = { cursorSeg: 0, cursorOffset: 40, endSeg: 1, endSize: 50 };
		// Segment 0: green read + RED remainder (lag continues into seg 1), no gray.
		const seg0 = fills(
			render(
				<SegmentBar
					segment={ { id: 0, size: 100 } }
					maxSize={ 100 }
					{ ...lag }
				/>
			).container
		);
		expect( seg0[ 0 ].width ).toBe( '40%' ); // green
		expect( seg0[ 1 ].className ).toBe( 'segment-fill-h ' ); // RED, not pending
		expect( seg0[ 1 ].width ).toBe( '60%' );
		expect( seg0[ 2 ].width ).toBe( '0%' );
		// Segment 1 (ahead): red backlog up to the recorded end, gray beyond.
		const seg1 = fills(
			render(
				<SegmentBar
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

	it( 'staggers the fill/offset transition left-to-right by segment index', () => {
		// index 2 → its fills wait 2 bar-durations so it starts as bar 1 finishes
		// (the slide-left keyframe is separate and stays simultaneous).
		const { container } = render(
			<SegmentBar
				segment={ { id: 2, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 2 }
				cursorOffset={ 50 }
				endSeg={ 2 }
				endSize={ 100 }
				index={ 2 }
			/>
		);
		const bar = container.querySelector( '.worker-segment-h' );
		expect( bar.style.getPropertyValue( '--seg-delay' ) ).toBe( '0.6s' );
	} );

	it( 'a fully-read older segment is all green (read past it)', () => {
		const { container } = render(
			<SegmentBar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 1 }
				cursorOffset={ 10 }
				endSeg={ 1 }
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

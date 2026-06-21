/**
 * SegmentBar — the three-region segment fill: green processed (0→cursor), a
 * red/yellow backlog the consumer knows about but hasn't read (cursor→recorded
 * probe end), and a gray "beyond" region for live bytes past the recorded end
 * (recorded end→live head). A segment in a tree with no consumer of the log
 * (cursorSeg null) renders entirely gray.
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
	it( 'a consumer caught up partway in its segment shows green + red, no gray', () => {
		// maxSize 100, segment id 0 size 100, cursor at 40, recorded end at 100.
		const { container } = render(
			<SegmentBar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 0 }
				cursorOffset={ 40 }
				endSeg={ 0 }
				endSize={ 100 }
				newestSegId={ 5 }
			/>
		);
		const f = fills( container );
		expect( f ).toHaveLength( 3 );
		expect( f[ 0 ].className ).toContain( 'processed' );
		expect( f[ 0 ].width ).toBe( '40%' );
		// Backlog = recorded(100) − read(40) = 60; not the newest segment → red ('').
		expect( f[ 1 ].className ).toBe( 'segment-fill-h ' );
		expect( f[ 1 ].width ).toBe( '60%' );
		// Beyond = size(100) − recorded(100) = 0.
		expect( f[ 2 ].className ).toContain( 'beyond' );
		expect( f[ 2 ].width ).toBe( '0%' );
	} );

	it( 'a stale recorded end (behind the live segment size) leaves a gray tail', () => {
		// Segment 0 is 100 bytes live, but the consumer's recorded end is only 60.
		const { container } = render(
			<SegmentBar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 0 }
				cursorOffset={ 20 }
				endSeg={ 0 }
				endSize={ 60 }
				newestSegId={ 5 }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].className ).toContain( 'processed' );
		expect( f[ 0 ].width ).toBe( '20%' );
		// Backlog = recorded(60) − read(20) = 40.
		expect( f[ 1 ].width ).toBe( '40%' );
		// Beyond = size(100) − recorded(60) = 40 of live data past the probe.
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
				newestSegId={ 5 }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].width ).toBe( '0%' ); // processed
		expect( f[ 1 ].width ).toBe( '0%' ); // backlog
		expect( f[ 2 ].className ).toContain( 'beyond' );
		expect( f[ 2 ].width ).toBe( '80%' ); // whole segment, scaled to maxSize 100
	} );

	it( 'the newest backlog segment is yellow (pending), older backlog is red', () => {
		const { container } = render(
			<SegmentBar
				segment={ { id: 5, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 5 }
				cursorOffset={ 30 }
				endSeg={ 5 }
				endSize={ 100 }
				newestSegId={ 5 }
			/>
		);
		const f = fills( container );
		expect( f[ 1 ].className ).toContain( 'pending' );
	} );

	it( 'a fully-read older segment is all green (read past it)', () => {
		// Segment 0, cursor is in segment 1 → segment 0 is fully processed.
		const { container } = render(
			<SegmentBar
				segment={ { id: 0, size: 100 } }
				maxSize={ 100 }
				cursorSeg={ 1 }
				cursorOffset={ 10 }
				endSeg={ 1 }
				endSize={ 50 }
				newestSegId={ 1 }
			/>
		);
		const f = fills( container );
		expect( f[ 0 ].className ).toContain( 'processed' );
		expect( f[ 0 ].width ).toBe( '100%' );
		expect( f[ 1 ].width ).toBe( '0%' );
		expect( f[ 2 ].width ).toBe( '0%' );
	} );
} );

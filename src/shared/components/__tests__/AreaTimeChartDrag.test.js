/**
 * AreaTimeChart — a left-button drag across the plot of at least one slot's
 * width, and at least 4px, selects the slot span it crossed, shaded live while
 * it runs, and reports it to `onSlotRange` on release; a shorter movement stays
 * a plain click.
 *
 * Real d3 and the real overlay against jsdom, so each pointer event lands on
 * the rect the hover binds, exactly as a pointer would.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { useState } from '@wordpress/element';
import AreaTimeChart from '../AreaTimeChart';

// Five slots; an unlaid container draws 800px wide, a 708px plot box, so the
// slots sit at x = 0, 177, 354, 531 and 708 and a column is 141.6px wide.
const SLOT_X = [ 0, 177, 354, 531, 708 ];
const dates = SLOT_X.map( ( _x, i ) => new Date( 1700000000000 + i * 300000 ) );
const SERIES = [
	{
		label: 'jobs.p0',
		values: dates.map( ( date, i ) => ( { date, value: 7 + i } ) ),
	},
];
const POINTER = 23;

let captured;
beforeAll( () => {
	// jsdom has no PointerEvent; a MouseEvent carries the coordinates.
	window.PointerEvent = class PointerEvent extends window.MouseEvent {
		constructor( type, init = {} ) {
			super( type, init );
			this.pointerId = init.pointerId ?? 0;
		}
	};
} );
beforeEach( () => {
	captured = [];
	window.Element.prototype.setPointerCapture = function ( id ) {
		captured.push( [ this, id ] );
	};
} );
afterEach( () => {
	delete window.Element.prototype.setPointerCapture;
} );

const chartProps = {
	yFormatFor: () => ( v ) => `${ v }u`,
	colorAt: () => '#123456',
	title: 'Backlog',
	height: 173,
	storageKey: 'test:drag-chart',
};

const mount = ( props = {} ) =>
	render(
		<AreaTimeChart series={ SERIES } { ...chartProps } { ...props } />
	);

const overlay = ( c ) =>
	c.querySelector( '.newspack-nodes-chart__plot rect[pointer-events="all"]' );
const shaded = ( c ) =>
	c.querySelectorAll( '.newspack-nodes-chart__selected' ).length;

const at = ( clientX, extra = {} ) => ( {
	clientX,
	pointerId: POINTER,
	...extra,
} );

/**
 * Press, move and release over the overlay, then the click a browser sends.
 *
 * @param {Element} c    The rendered container.
 * @param {number}  from Press x.
 * @param {number}  to   Release x.
 * @param {Object}  up   Extra fields on the release.
 */
const drag = ( c, from, to, up = {} ) => {
	fireEvent.pointerDown( overlay( c ), at( from ) );
	fireEvent.pointerMove( overlay( c ), at( to ) );
	fireEvent.pointerUp( overlay( c ), at( to, up ) );
	fireEvent.click( overlay( c ), at( to, up ) );
};

describe( 'AreaTimeChart drag-to-select', () => {
	it( 'reports a drag from slot 1 to slot 3 as that span, and no click', () => {
		const onSlotRange = jest.fn();
		const onSlotClick = jest.fn();
		const { container } = mount( { onSlotRange, onSlotClick } );
		drag( container, SLOT_X[ 1 ], SLOT_X[ 3 ] );
		expect( onSlotRange ).toHaveBeenCalledTimes( 1 );
		expect( onSlotRange ).toHaveBeenCalledWith( 1, 3, {
			additive: false,
		} );
		expect( onSlotClick ).not.toHaveBeenCalled();
	} );

	it( 'orders a reverse drag low to high', () => {
		const onSlotRange = jest.fn();
		const { container } = mount( { onSlotRange } );
		drag( container, SLOT_X[ 3 ], SLOT_X[ 1 ] );
		expect( onSlotRange ).toHaveBeenCalledWith( 1, 3, {
			additive: false,
		} );
	} );

	it.each( [ [ 'metaKey' ], [ 'ctrlKey' ] ] )(
		'reports a drag released with %s held as additive',
		( key ) => {
			const onSlotRange = jest.fn();
			const { container } = mount( { onSlotRange } );
			drag( container, SLOT_X[ 1 ], SLOT_X[ 3 ], { [ key ]: true } );
			expect( onSlotRange ).toHaveBeenCalledWith( 1, 3, {
				additive: true,
			} );
		}
	);

	it( 'keeps a movement under one slot wide a plain click', () => {
		const onSlotRange = jest.fn();
		const onSlotClick = jest.fn();
		const { container } = mount( { onSlotRange, onSlotClick } );
		drag( container, SLOT_X[ 1 ], SLOT_X[ 1 ] + 60 );
		expect( onSlotRange ).not.toHaveBeenCalled();
		expect( onSlotClick ).toHaveBeenCalledTimes( 1 );
		expect( onSlotClick ).toHaveBeenCalledWith( 1, { additive: false } );
	} );

	it( 'keeps a 3px jitter a click where a column is narrower than that', () => {
		const onSlotRange = jest.fn();
		const onSlotClick = jest.fn();
		const day = Array.from(
			{ length: 288 },
			( _v, i ) => new Date( 1700000000000 + i * 300000 )
		);
		const { container } = mount( {
			series: [
				{
					label: 'jobs.p0',
					values: day.map( ( date, i ) => ( {
						date,
						value: 3 + i,
					} ) ),
				},
			],
			onSlotRange,
			onSlotClick,
		} );
		drag( container, 354, 357 );
		expect( onSlotRange ).not.toHaveBeenCalled();
		expect( onSlotClick ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'starts no drag from a right-button press', () => {
		const onSlotRange = jest.fn();
		const { container } = mount( { onSlotRange } );
		fireEvent.pointerDown(
			overlay( container ),
			at( SLOT_X[ 1 ], { button: 2 } )
		);
		fireEvent.pointerMove(
			overlay( container ),
			at( SLOT_X[ 3 ], { button: 2 } )
		);
		expect( shaded( container ) ).toBe( 0 );
		fireEvent.pointerUp(
			overlay( container ),
			at( SLOT_X[ 3 ], { button: 2 } )
		);
		expect( onSlotRange ).not.toHaveBeenCalled();
		expect( captured ).toEqual( [] );
	} );

	it( "ignores a second pointer's move and release mid-drag", () => {
		const onSlotRange = jest.fn();
		const { container } = mount( { onSlotRange } );
		const other = { pointerId: 41 };
		fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 3 ] ) );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 4 ], other ) );
		expect( shaded( container ) ).toBe( 3 );
		fireEvent.pointerUp( overlay( container ), at( SLOT_X[ 4 ], other ) );
		expect( onSlotRange ).not.toHaveBeenCalled();
		fireEvent.pointerUp( overlay( container ), at( SLOT_X[ 3 ] ) );
		expect( onSlotRange ).toHaveBeenCalledWith( 1, 3, {
			additive: false,
		} );
	} );

	it( "ignores a second pointer's cancel mid-drag", () => {
		const onSlotRange = jest.fn();
		const { container } = mount( { onSlotRange } );
		fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 3 ] ) );
		fireEvent.pointerCancel(
			overlay( container ),
			at( SLOT_X[ 4 ], { pointerId: 43 } )
		);
		expect( shaded( container ) ).toBe( 3 );
		fireEvent.pointerUp( overlay( container ), at( SLOT_X[ 3 ] ) );
		expect( onSlotRange ).toHaveBeenCalledWith( 1, 3, {
			additive: false,
		} );
	} );

	it( 'shades the dragged span live, and clears it on release', () => {
		const { container } = mount( { onSlotRange: jest.fn() } );
		fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
		expect( shaded( container ) ).toBe( 0 );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 3 ] ) );
		expect( shaded( container ) ).toBe( 3 );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 2 ] ) );
		expect( shaded( container ) ).toBe( 2 );
		fireEvent.pointerUp( overlay( container ), at( SLOT_X[ 2 ] ) );
		expect( shaded( container ) ).toBe( 0 );
	} );

	it( 'captures the pointer it was pressed with', () => {
		const { container } = mount( { onSlotRange: jest.fn() } );
		fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
		expect( captured ).toEqual( [ [ overlay( container ), POINTER ] ] );
	} );

	it( 'clamps a drag that leaves the plot to the edge slot', () => {
		const onSlotRange = jest.fn();
		const { container } = mount( { onSlotRange } );
		drag( container, SLOT_X[ 1 ], 5000 );
		drag( container, SLOT_X[ 3 ], -900 );
		expect( onSlotRange.mock.calls ).toEqual( [
			[ 1, 4, { additive: false } ],
			[ 0, 3, { additive: false } ],
		] );
	} );

	it( 'cancels on Escape: no span, no click, and the shade clears', () => {
		const onSlotRange = jest.fn();
		const onSlotClick = jest.fn();
		const { container } = mount( { onSlotRange, onSlotClick } );
		fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 3 ] ) );
		fireEvent.keyDown( document.body, { key: 'Escape' } );
		expect( shaded( container ) ).toBe( 0 );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 4 ] ) );
		expect( shaded( container ) ).toBe( 0 );
		fireEvent.pointerUp( overlay( container ), at( SLOT_X[ 4 ] ) );
		fireEvent.click( overlay( container ), at( SLOT_X[ 4 ] ) );
		expect( onSlotRange ).not.toHaveBeenCalled();
		expect( onSlotClick ).not.toHaveBeenCalled();
		// The next press starts afresh.
		drag( container, SLOT_X[ 0 ], SLOT_X[ 0 ] );
		expect( onSlotClick ).toHaveBeenCalledWith( 0, { additive: false } );
	} );

	it( "keeps a drag's Escape from a modal's handler, and only a drag's", () => {
		const modalEscape = jest.fn();
		document.addEventListener( 'keydown', modalEscape );
		try {
			const { container } = mount( { onSlotRange: jest.fn() } );
			fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
			fireEvent.keyDown( document.body, { key: 'Escape' } );
			expect( modalEscape ).not.toHaveBeenCalled();
			fireEvent.keyDown( document.body, { key: 'Escape' } );
			expect( modalEscape ).toHaveBeenCalledTimes( 1 );
		} finally {
			document.removeEventListener( 'keydown', modalEscape );
		}
	} );

	it( 'carries a drag across a redraw, recapturing the pointer', () => {
		const onSlotRange = jest.fn();
		const { container, rerender } = mount( { onSlotRange } );
		fireEvent.pointerDown( overlay( container ), at( SLOT_X[ 1 ] ) );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 3 ] ) );
		const before = overlay( container );
		rerender(
			<AreaTimeChart
				series={ [ { ...SERIES[ 0 ], label: 'jobs.p9' } ] }
				{ ...chartProps }
				onSlotRange={ onSlotRange }
			/>
		);
		expect( overlay( container ) ).not.toBe( before );
		expect( shaded( container ) ).toBe( 3 );
		expect( captured.at( -1 ) ).toEqual( [
			overlay( container ),
			POINTER,
		] );
		fireEvent.pointerMove( overlay( container ), at( SLOT_X[ 4 ] ) );
		fireEvent.pointerUp( overlay( container ), at( SLOT_X[ 4 ] ) );
		expect( onSlotRange ).toHaveBeenCalledWith( 1, 4, {
			additive: false,
		} );
	} );

	it( 'swallows the release click even when the span redraws the chart', () => {
		const onSlotClick = jest.fn();
		const Picker = () => {
			const [ picked, setPicked ] = useState( new Set() );
			return (
				<AreaTimeChart
					series={ SERIES }
					{ ...chartProps }
					selectedSlots={ picked }
					onSlotClick={ onSlotClick }
					onSlotRange={ ( lo, hi ) =>
						setPicked(
							new Set(
								Array.from(
									{ length: hi - lo + 1 },
									( _v, i ) => lo + i
								)
							)
						)
					}
				/>
			);
		};
		const { container } = render( <Picker /> );
		act( () => drag( container, SLOT_X[ 3 ], SLOT_X[ 1 ] ) );
		expect( shaded( container ) ).toBe( 3 );
		expect( onSlotClick ).not.toHaveBeenCalled();
	} );

	it( 'arms no drag without onSlotRange: a drag stays a click', () => {
		const onSlotClick = jest.fn();
		const { container } = mount( { onSlotClick } );
		drag( container, SLOT_X[ 1 ], SLOT_X[ 3 ] );
		expect( shaded( container ) ).toBe( 0 );
		expect( captured ).toEqual( [] );
		expect( onSlotClick ).toHaveBeenCalledWith( 3, { additive: false } );
	} );
} );

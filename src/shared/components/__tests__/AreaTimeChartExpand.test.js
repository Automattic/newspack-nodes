/**
 * AreaTimeChart — the corner expand button toggles the chart to double its
 * height, and is the only control that does; a click on the plot reports the
 * nearest slot's index, shift or not.
 *
 * Real d3 and the real tooltip against jsdom, so a click lands on the overlay
 * rect the hover binds, exactly as a pointer would.
 */

import { render, fireEvent } from '@testing-library/react';
import AreaTimeChart from '../AreaTimeChart';

const HEIGHT = 173;
const dates = [ 0, 1, 2 ].map( ( i ) => new Date( 1700000000000 + i * 60000 ) );
const SERIES = [
	{
		label: 'jobs.p0',
		values: dates.map( ( date ) => ( { date, value: 30 } ) ),
	},
	{
		label: 'jobs.p1',
		values: dates.map( ( date ) => ( { date, value: 10 } ) ),
	},
];

const mount = ( series = SERIES, props = {} ) =>
	render(
		<AreaTimeChart
			series={ series }
			yFormatFor={ () => ( v ) => `${ v }u` }
			colorAt={ ( _l, i ) => [ '#111111', '#222222' ][ i ] }
			title="Backlog"
			height={ HEIGHT }
			{ ...props }
		/>
	);

// The transparent rect over the plot that takes the pointer.
const overlay = ( c ) =>
	c.querySelector( '.newspack-nodes-chart__plot rect[pointer-events="all"]' );
// An unlaid container draws 800px wide, so the plot box is 708px.
const LAST_SLOT_X = 700;

const plot = ( c ) => c.querySelector( '.newspack-nodes-chart__plot' );
const svgHeight = ( c ) =>
	Number(
		c
			.querySelector( '.newspack-nodes-chart__plot svg' )
			.getAttribute( 'height' )
	);
const expandButton = ( c ) =>
	c.querySelector( '.newspack-nodes-chart__expand' );
const legendMax = ( c ) =>
	c.querySelector( '.newspack-nodes-chart-legend' ).style.maxHeight;

describe( 'AreaTimeChart expand', () => {
	it( 'doubles the draw, the plot and the legend from the corner button, and restores them on the next press', () => {
		const { container } = mount();
		const button = expandButton( container );
		expect( button.tagName ).toBe( 'BUTTON' );
		expect( button.getAttribute( 'type' ) ).toBe( 'button' );
		expect( button.parentElement ).toBe(
			container.querySelector( '.newspack-nodes-chart__stack' )
				.parentElement
		);
		expect( button.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
		expect( button.getAttribute( 'aria-label' ) ).toBe( 'Expand Backlog' );
		expect( button.getAttribute( 'title' ) ).toBe( 'Expand Backlog' );
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect( plot( container ).style.minHeight ).toBe( '173px' );
		expect( legendMax( container ) ).toBe( '173px' );

		fireEvent.click( button );
		expect( button.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		expect( button.getAttribute( 'aria-label' ) ).toBe( 'Shrink Backlog' );
		expect( button.getAttribute( 'title' ) ).toBe( 'Shrink Backlog' );
		expect( svgHeight( container ) ).toBe( 346 );
		expect( plot( container ).style.minHeight ).toBe( '346px' );
		expect( legendMax( container ) ).toBe( '346px' );

		fireEvent.click( button );
		expect( button.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
		expect( button.getAttribute( 'aria-label' ) ).toBe( 'Expand Backlog' );
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect( legendMax( container ) ).toBe( '173px' );
	} );

	it( 'keeps the corner button when the chart declines the stack toggle', () => {
		const { container } = mount( SERIES, { stackable: false } );
		expect(
			container.querySelector( '.newspack-nodes-chart__stack' )
		).toBeNull();
		fireEvent.click( expandButton( container ) );
		expect( svgHeight( container ) ).toBe( 346 );
	} );

	it( 'leaves the plot a plain element, not a button', () => {
		const { container } = mount();
		const p = plot( container );
		expect( p.hasAttribute( 'role' ) ).toBe( false );
		expect( p.hasAttribute( 'tabindex' ) ).toBe( false );
		expect( p.hasAttribute( 'aria-expanded' ) ).toBe( false );
		expect( p.hasAttribute( 'aria-label' ) ).toBe( false );
		fireEvent.keyDown( p, { key: 'Enter' } );
		fireEvent.keyDown( p, { key: ' ' } );
		expect( svgHeight( container ) ).toBe( HEIGHT );
	} );

	it( 'keeps its size on a shift+click, or a plain click, on the plot', () => {
		const { container } = mount();
		fireEvent.click( plot( container ), { shiftKey: true } );
		fireEvent.click( plot( container ) );
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect(
			expandButton( container ).getAttribute( 'aria-expanded' )
		).toBe( 'false' );
	} );

	it( 'leaves a shift+mousedown on the plot its default', () => {
		const { container } = mount();
		expect(
			fireEvent.mouseDown( plot( container ), { shiftKey: true } )
		).toBe( true );
	} );

	it( "hands a plain click's nearest slot index to onSlotClick, and keeps its size", () => {
		const onSlotClick = jest.fn();
		const { container } = mount( SERIES, { onSlotClick } );
		fireEvent.click( overlay( container ), { clientX: LAST_SLOT_X } );
		expect( onSlotClick ).toHaveBeenCalledTimes( 1 );
		expect( onSlotClick ).toHaveBeenCalledWith( 2, { additive: false } );
		expect( svgHeight( container ) ).toBe( HEIGHT );
	} );

	it.each( [ [ 'metaKey' ], [ 'ctrlKey' ] ] )(
		'reports a %s click on the plot as additive, and keeps its size',
		( key ) => {
			const onSlotClick = jest.fn();
			const { container } = mount( SERIES, { onSlotClick } );
			fireEvent.click( overlay( container ), {
				clientX: LAST_SLOT_X,
				[ key ]: true,
			} );
			expect( onSlotClick ).toHaveBeenCalledTimes( 1 );
			expect( onSlotClick ).toHaveBeenCalledWith( 2, { additive: true } );
			expect( svgHeight( container ) ).toBe( HEIGHT );
		}
	);

	it( 'reports no slot when the corner button is pressed', () => {
		const onSlotClick = jest.fn();
		const { container } = mount( SERIES, { onSlotClick } );
		fireEvent.click( expandButton( container ) );
		expect( svgHeight( container ) ).toBe( 346 );
		expect( onSlotClick ).not.toHaveBeenCalled();
	} );

	it( 'reports a shift+click as a plain click, and keeps its size', () => {
		const onSlotClick = jest.fn();
		const { container } = mount( SERIES, { onSlotClick } );
		fireEvent.click( overlay( container ), {
			clientX: LAST_SLOT_X,
			shiftKey: true,
		} );
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect( onSlotClick ).toHaveBeenCalledWith( 2, { additive: false } );
	} );

	it( 'does nothing on a plain click when no onSlotClick is given', () => {
		const { container } = mount();
		expect( () =>
			fireEvent.click( overlay( container ), { clientX: LAST_SLOT_X } )
		).not.toThrow();
		expect( svgHeight( container ) ).toBe( HEIGHT );
	} );

	it( 'does not toggle from the legend, the stack button or the title', () => {
		const { container } = mount();
		fireEvent.click(
			container.querySelector( '.newspack-nodes-chart-legend button' )
		);
		fireEvent.click(
			container.querySelector( '.newspack-nodes-chart__stack' )
		);
		fireEvent.click(
			container.querySelector( '.newspack-nodes-chart__title' )
		);
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect(
			expandButton( container ).getAttribute( 'aria-expanded' )
		).toBe( 'false' );
	} );

	it( 'keeps a drag-selection over the labels from reporting a slot', () => {
		const onSlotClick = jest.fn();
		const { container } = mount( SERIES, { onSlotClick } );
		const spy = jest
			.spyOn( window, 'getSelection' )
			.mockReturnValue( { isCollapsed: false } );
		fireEvent.click( overlay( container ), { clientX: LAST_SLOT_X } );
		spy.mockRestore();
		expect( onSlotClick ).not.toHaveBeenCalled();
	} );

	it( 'offers no expand button while nothing is drawn', () => {
		const { container } = mount( [] );
		expect( expandButton( container ) ).toBeNull();
		expect( plot( container ).style.minHeight ).toBe( '173px' );
	} );
} );

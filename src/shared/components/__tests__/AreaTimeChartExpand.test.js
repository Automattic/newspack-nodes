/**
 * AreaTimeChart — clicking the plot toggles the chart to double its height.
 */

jest.mock( '../../hooks/useTimeChart', () => ( {
	__esModule: true,
	...jest.requireActual( '../../hooks/useTimeChart' ),
	setupTooltip: jest.fn(),
} ) );

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

const mount = ( series = SERIES ) =>
	render(
		<AreaTimeChart
			series={ series }
			yFormatFor={ () => ( v ) => `${ v }u` }
			colorAt={ ( _l, i ) => [ '#111111', '#222222' ][ i ] }
			title="Backlog"
			height={ HEIGHT }
		/>
	);

const plot = ( c ) => c.querySelector( '.newspack-nodes-chart__plot' );
const svgHeight = ( c ) =>
	Number(
		c
			.querySelector( '.newspack-nodes-chart__plot svg' )
			.getAttribute( 'height' )
	);
const legendMax = ( c ) =>
	c.querySelector( '.newspack-nodes-chart-legend' ).style.maxHeight;

describe( 'AreaTimeChart expand', () => {
	it( 'doubles the draw, the plot and the legend on a plot click, and restores them on the next', () => {
		const { container } = mount();
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect( plot( container ).style.minHeight ).toBe( '173px' );
		expect( legendMax( container ) ).toBe( '173px' );

		fireEvent.click( plot( container ) );
		expect( svgHeight( container ) ).toBe( 346 );
		expect( plot( container ).style.minHeight ).toBe( '346px' );
		expect( legendMax( container ) ).toBe( '346px' );

		fireEvent.click( plot( container ) );
		expect( svgHeight( container ) ).toBe( HEIGHT );
		expect( legendMax( container ) ).toBe( '173px' );
	} );

	it( 'is a keyboard button whose aria-expanded and label track the state', () => {
		const { container } = mount();
		const p = plot( container );
		expect( p.getAttribute( 'role' ) ).toBe( 'button' );
		expect( p.tabIndex ).toBe( 0 );
		expect( p.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
		expect( p.getAttribute( 'aria-label' ) ).toBe( 'Expand Backlog' );
		expect( p.hasAttribute( 'title' ) ).toBe( false );

		fireEvent.keyDown( p, { key: 'Enter' } );
		expect( p.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		expect( p.getAttribute( 'aria-label' ) ).toBe( 'Shrink Backlog' );
		expect( svgHeight( container ) ).toBe( 346 );

		fireEvent.keyDown( p, { key: ' ' } );
		expect( p.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
		expect( svgHeight( container ) ).toBe( HEIGHT );
	} );

	it( 'ignores other keys', () => {
		const { container } = mount();
		fireEvent.keyDown( plot( container ), { key: 'a' } );
		expect( svgHeight( container ) ).toBe( HEIGHT );
	} );

	it( 'does not toggle from the legend or the stack button', () => {
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
		expect( plot( container ).getAttribute( 'aria-expanded' ) ).toBe(
			'false'
		);
	} );

	it( 'keeps a drag-selection over the labels from toggling', () => {
		const { container } = mount();
		const spy = jest
			.spyOn( window, 'getSelection' )
			.mockReturnValue( { isCollapsed: false } );
		fireEvent.click( plot( container ) );
		spy.mockRestore();
		expect( svgHeight( container ) ).toBe( HEIGHT );
		fireEvent.click( plot( container ) );
		expect( svgHeight( container ) ).toBe( 346 );
	} );

	it( 'is no button while nothing is drawn', () => {
		const { container } = mount( [] );
		const p = plot( container );
		expect( p.hasAttribute( 'role' ) ).toBe( false );
		expect( p.hasAttribute( 'tabindex' ) ).toBe( false );
		fireEvent.click( p );
		expect( p.hasAttribute( 'aria-expanded' ) ).toBe( false );
	} );
} );

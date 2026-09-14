/**
 * AreaTimeChart — the one area-chart frame every dashboard time chart draws on.
 *
 * Real d3 against jsdom on purpose: the mocked-d3 suites resolve every
 * selection to one shared chainable, so they cannot see where a band lands.
 * Only the tooltip is stubbed, to read the rows it would have printed.
 */

jest.mock( '../../hooks/useTimeChart', () => ( {
	__esModule: true,
	...jest.requireActual( '../../hooks/useTimeChart' ),
	setupTooltip: jest.fn(),
} ) );

import { render, fireEvent, act } from '@testing-library/react';
import { MARGIN, setupTooltip } from '../../hooks/useTimeChart';
import AreaTimeChart from '../AreaTimeChart';

const HEIGHT = 200;
const INNER_H = HEIGHT - MARGIN.top - MARGIN.bottom;
// The axis pads the peak by 1.1, so the tallest band tops out here.
const CEILING = INNER_H * ( 1 - 1 / 1.1 );

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
const colorAt = ( _label, i ) => [ '#111111', '#222222' ][ i ];
const yFormatFor = () => ( v ) => `${ v }u`;

const mount = ( props = {} ) =>
	render(
		<AreaTimeChart
			series={ SERIES }
			yFormatFor={ yFormatFor }
			colorAt={ colorAt }
			title="Backlog"
			height={ HEIGHT }
			{ ...props }
		/>
	);

/**
 * The area paths, in draw order.
 *
 * @param {Element} container The rendered chart.
 * @return {Array<Element>} Its band paths.
 */
const bands = ( container ) =>
	[ ...container.querySelectorAll( 'svg path' ) ].filter( ( p ) =>
		p.style.fill.startsWith( '#' )
	);

/**
 * Smallest y in a path's `d`: how far up it reaches.
 *
 * @param {Element} path A band path.
 * @return {number} Its highest point.
 */
const highestPoint = ( path ) =>
	Math.min(
		...[
			...path.getAttribute( 'd' ).matchAll( /(-?[\d.]+),(-?[\d.]+)/g ),
		].map( ( m ) => Number( m[ 2 ] ) )
	);

const stackButton = ( container ) =>
	container.querySelector( '.newspack-nodes-chart__stack' );

/**
 * The rows the tooltip would print for slot `idx` on the last draw.
 *
 * @param {number} idx The slot.
 * @return {Array<Object>} The rows.
 */
const tooltipRows = ( idx ) =>
	setupTooltip.mock.calls.at( -1 )[ 1 ].formatEntry( idx );

beforeEach( () => setupTooltip.mockClear() );

describe( 'AreaTimeChart', () => {
	it( 'lays out title, plot, legend and tooltip under the shared chart roles', () => {
		const { container } = mount();
		const chart = container.querySelector( '.newspack-nodes-chart' );
		expect(
			chart.querySelector( 'h3.newspack-nodes-chart__title' ).textContent
		).toBe( 'Backlog' );
		expect(
			chart.querySelector(
				'.newspack-nodes-chart__row > .newspack-nodes-chart__plot svg'
			)
		).not.toBeNull();
		expect(
			chart.querySelectorAll(
				'.newspack-nodes-chart__row > .newspack-nodes-chart-legend li'
			)
		).toHaveLength( 2 );
		// The tooltip is the elevated card, a child of the positioned chart.
		const tooltip = chart.querySelector( '.newspack-nodes-chart__tooltip' );
		expect(
			tooltip.classList.contains( 'newspack-nodes-card--elevated' )
		).toBe( true );
		expect( chart.style.position ).toBe( 'relative' );
	} );

	it( 'overlays by default: every band rises from the baseline', () => {
		const { container } = mount();
		const [ tall, short ] = bands( container );
		expect( highestPoint( tall ) ).toBeCloseTo( CEILING, 3 );
		// 10 of a 33 ceiling: well below the tall band's top.
		expect( highestPoint( short ) ).toBeGreaterThan( CEILING * 2 );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'false'
		);
		expect( tall.style.fill ).toBe( '#111111' );
	} );

	it( 'stacks when asked: the top band peaks at the stack total', () => {
		const { container } = mount( { stacked: true } );
		const [ bottom, top ] = bands( container );
		expect( highestPoint( top ) ).toBeCloseTo( CEILING, 3 );
		expect( highestPoint( bottom ) ).toBeGreaterThan( CEILING );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'true'
		);
	} );

	it( 'the corner toggle flips stacking for this chart alone', () => {
		const { container } = mount();
		act( () => fireEvent.click( stackButton( container ) ) );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'true'
		);
		const [ bottom, top ] = bands( container );
		expect( highestPoint( top ) ).toBeCloseTo( CEILING, 3 );
		expect( highestPoint( bottom ) ).toBeGreaterThan( CEILING );

		// A second chart with the same props is untouched.
		const other = mount();
		expect(
			stackButton( other.container ).getAttribute( 'aria-pressed' )
		).toBe( 'false' );

		act( () => fireEvent.click( stackButton( container ) ) );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'false'
		);
	} );

	it( "a changed caller default outranks the reader's earlier pick", () => {
		const { container, rerender } = mount( { stacked: true } );
		act( () => fireEvent.click( stackButton( container ) ) );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'false'
		);
		// The caller moved to a metric that overlays, then back to one that
		// stacks: the pick was about the first default, so the chart follows
		// each new one rather than pinning overlay for the life of the mount.
		const at = ( stacked ) =>
			rerender(
				<AreaTimeChart
					series={ SERIES }
					yFormatFor={ yFormatFor }
					colorAt={ colorAt }
					title="Backlog"
					height={ HEIGHT }
					stacked={ stacked }
				/>
			);
		at( false );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'false'
		);
		at( true );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'true'
		);
	} );

	it( 'offers no toggle where the caller says the bands must not be summed', () => {
		const { container } = mount( { stackable: false } );
		expect( stackButton( container ) ).toBeNull();
		expect( bands( container ) ).toHaveLength( 2 );
	} );

	it( "the tooltip's total row rides on the stack, not on the caller's default", () => {
		const { container } = mount( { totalLabel: 'Total' } );
		expect( tooltipRows( 1 ).map( ( r ) => r.label ) ).toEqual( [
			'jobs.p0',
			'jobs.p1',
		] );
		act( () => fireEvent.click( stackButton( container ) ) );
		expect( tooltipRows( 1 )[ 0 ] ).toEqual( {
			label: 'Total',
			value: '40u',
		} );
	} );

	it( 'a pick draws one series alone and keeps the total over the whole list', () => {
		const { container } = mount( { stacked: true, totalLabel: 'Total' } );
		act( () =>
			fireEvent.click(
				container.querySelectorAll(
					'.newspack-nodes-chart-legend button'
				)[ 1 ]
			)
		);
		const [ only ] = bands( container );
		expect( bands( container ) ).toHaveLength( 1 );
		expect( only.style.fill ).toBe( '#222222' );
		expect( highestPoint( only ) ).toBeCloseTo( CEILING, 3 );
		expect( tooltipRows( 0 ) ).toEqual( [
			{ label: 'Total', value: '40u' },
			{ label: 'jobs.p1', value: '10u', raw: 10 },
		] );
	} );

	it( 'wipes the plot when the series goes empty, so a reset clears it', () => {
		const { container, rerender } = mount();
		expect( bands( container ) ).toHaveLength( 2 );
		rerender(
			<AreaTimeChart
				series={ [] }
				yFormatFor={ yFormatFor }
				colorAt={ colorAt }
				title="Backlog"
				height={ HEIGHT }
			/>
		);
		expect(
			container.querySelector( '.newspack-nodes-chart__plot svg' )
		).toBeNull();
		expect(
			container.querySelectorAll( '.newspack-nodes-chart-legend li' )
		).toHaveLength( 0 );
	} );

	it( 'draws the caller-named Y title through the shared axes', () => {
		const { container } = mount( { yLabel: 'bytes' } );
		expect(
			container.querySelector( 'svg text.y-label' ).textContent
		).toBe( 'bytes' );
	} );
} );

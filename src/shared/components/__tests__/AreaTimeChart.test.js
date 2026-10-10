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
const KEY = 'test:area-chart';
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
			storageKey={ KEY }
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

beforeEach( () => {
	setupTooltip.mockClear();
	window.localStorage.clear();
} );

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

		// A second chart under its own key is untouched.
		const other = mount( { storageKey: 'test:other-chart' } );
		expect(
			stackButton( other.container ).getAttribute( 'aria-pressed' )
		).toBe( 'false' );

		act( () => fireEvent.click( stackButton( container ) ) );
		expect( stackButton( container ).getAttribute( 'aria-pressed' ) ).toBe(
			'false'
		);
	} );

	describe( 'a slot with no value', () => {
		const wide = [ 0, 1, 2, 3, 4 ].map(
			( i ) => new Date( 1700000000000 + i * 60000 )
		);
		const gapped = [
			{
				label: 'edge-kea',
				values: wide.map( ( date, i ) => ( {
					date,
					value: [ 12, 17, null, 41, 23 ][ i ],
				} ) ),
			},
		];
		const subpaths = ( path ) =>
			( path.getAttribute( 'd' ).match( /M/g ) ?? [] ).length;

		it( 'splits the band there, and never plots the gap as 0', () => {
			const { container } = mount( { series: gapped } );
			expect( subpaths( bands( container )[ 0 ] ) ).toBe( 2 );
		} );

		it( 'marks a lone measured slot with a dot, which its zero-width area cannot show', () => {
			const { container } = mount( {
				series: [
					{
						label: 'edge-kea',
						values: wide.slice( 0, 3 ).map( ( date, i ) => ( {
							date,
							value: [ null, 5, null ][ i ],
						} ) ),
					},
				],
			} );
			const dots = container.querySelectorAll( 'svg circle' );

			expect( dots ).toHaveLength( 1 );
			expect( dots[ 0 ].style.fill ).toBe( '#111111' );
			expect( Number( dots[ 0 ].getAttribute( 'cy' ) ) ).toBeCloseTo(
				CEILING,
				3
			);
		} );

		it.each( [
			[ 'first', [ 7, null, null ] ],
			[ 'last', [ null, null, 9 ] ],
		] )(
			'marks a lone measured slot at the %s edge with a dot',
			( _edge, values ) => {
				const { container } = mount( {
					series: [
						{
							label: 'edge-kea',
							values: wide.slice( 0, 3 ).map( ( date, i ) => ( {
								date,
								value: values[ i ],
							} ) ),
						},
					],
				} );
				const dots = container.querySelectorAll( 'svg circle' );

				expect( dots ).toHaveLength( 1 );
				expect( Number( dots[ 0 ].getAttribute( 'cy' ) ) ).toBeCloseTo(
					CEILING,
					3
				);
			}
		);

		it( 'marks no dot where every measured slot has a measured neighbour', () => {
			const { container } = mount( { series: gapped } );
			expect( container.querySelectorAll( 'svg circle' ) ).toHaveLength(
				0
			);
		} );

		it( 'draws a band with every slot measured as one path', () => {
			const { container } = mount( {
				series: [
					{
						label: 'edge-kea',
						values: wide.map( ( date ) => ( { date, value: 5 } ) ),
					},
				],
			} );
			expect( subpaths( bands( container )[ 0 ] ) ).toBe( 1 );
		} );

		it( 'scales the axis to the measured peak and lists the gap in no tooltip row', () => {
			const { container } = mount( { series: gapped } );
			expect( highestPoint( bands( container )[ 0 ] ) ).toBeCloseTo(
				CEILING,
				3
			);
			expect( tooltipRows( 2 ) ).toEqual( [] );
			expect( tooltipRows( 3 ).map( ( r ) => r.raw ) ).toEqual( [ 41 ] );
		} );
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
				storageKey={ KEY }
			/>
		);
		expect(
			container.querySelector( '.newspack-nodes-chart__plot svg' )
		).toBeNull();
		expect(
			container.querySelectorAll( '.newspack-nodes-chart-legend li' )
		).toHaveLength( 0 );
	} );

	describe( 'selected slots', () => {
		// Five slots on an unlaid 800px container: a 708px plot box.
		const five = [ 0, 1, 2, 3, 4 ].map(
			( i ) => new Date( 1700000000000 + i * 60000 )
		);
		const FIVE = [
			{
				label: 'jobs.p0',
				values: five.map( ( date ) => ( { date, value: 30 } ) ),
			},
		];
		const SLOT_W = 708 / 5;
		const PITCH = 708 / 4;
		const shaded = ( container ) => [
			...container.querySelectorAll(
				'svg rect.newspack-nodes-chart__selected'
			),
		];
		const at = ( rect ) => Number( rect.getAttribute( 'x' ) );

		it( 'shades each selected slot one bucket wide, centred on it', () => {
			const { container } = mount( {
				series: FIVE,
				selectedSlots: new Set( [ 1, 3 ] ),
			} );
			const rects = shaded( container );
			expect( rects ).toHaveLength( 2 );
			expect( at( rects[ 0 ] ) ).toBeCloseTo( PITCH - SLOT_W / 2, 3 );
			expect( at( rects[ 1 ] ) ).toBeCloseTo( 3 * PITCH - SLOT_W / 2, 3 );
			for ( const rect of rects ) {
				expect( Number( rect.getAttribute( 'width' ) ) ).toBeCloseTo(
					SLOT_W,
					3
				);
				expect( Number( rect.getAttribute( 'height' ) ) ).toBe(
					INNER_H
				);
			}
		} );

		it( 'draws the shading beneath the bands', () => {
			const { container } = mount( {
				series: FIVE,
				selectedSlots: new Set( [ 2 ] ),
			} );
			const [ rect ] = shaded( container );
			expect(
				rect.compareDocumentPosition( bands( container )[ 0 ] ) &
					window.Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
		} );

		it.each( [
			[ 'absent', undefined ],
			[ 'empty', new Set() ],
		] )( 'shades nothing when the set is %s', ( _case, selectedSlots ) => {
			const { container } = mount( { series: FIVE, selectedSlots } );
			expect( shaded( container ) ).toHaveLength( 0 );
		} );

		it( 'redraws when the selection changes', () => {
			const props = {
				series: FIVE,
				yFormatFor,
				colorAt,
				title: 'Backlog',
				height: HEIGHT,
				storageKey: KEY,
			};
			const { container, rerender } = render(
				<AreaTimeChart
					{ ...props }
					selectedSlots={ new Set( [ 1 ] ) }
				/>
			);
			rerender(
				<AreaTimeChart
					{ ...props }
					selectedSlots={ new Set( [ 4 ] ) }
				/>
			);
			const rects = shaded( container );
			expect( rects ).toHaveLength( 1 );
			expect( at( rects[ 0 ] ) ).toBeCloseTo( 4 * PITCH - SLOT_W / 2, 3 );
		} );
	} );

	describe( 'stack persistence', () => {
		const STACK_KEY = `${ KEY }:stack`;
		const pressed = ( c ) =>
			stackButton( c ).getAttribute( 'aria-pressed' );

		it( 'writes the toggled stack to <storageKey>:stack', () => {
			const { container } = mount();
			act( () => fireEvent.click( stackButton( container ) ) );
			expect( window.localStorage.getItem( STACK_KEY ) ).toBe( '1' );
		} );

		it( 'reads a stored stack over the caller default', () => {
			window.localStorage.setItem( STACK_KEY, '1' );
			const { container } = mount();
			expect( pressed( container ) ).toBe( 'true' );
			const [ bottom, top ] = bands( container );
			expect( highestPoint( top ) ).toBeCloseTo( CEILING, 3 );
			expect( highestPoint( bottom ) ).toBeGreaterThan( CEILING );
		} );

		it( 'follows the caller default and writes nothing until toggled', () => {
			const { container } = mount( { stacked: true } );
			expect( pressed( container ) ).toBe( 'true' );
			expect( window.localStorage.getItem( STACK_KEY ) ).toBeNull();
		} );

		it( 'ignores a stored stack on a chart that declines the toggle', () => {
			window.localStorage.setItem( STACK_KEY, '1' );
			const { container } = mount( { stacked: false, stackable: false } );
			expect( stackButton( container ) ).toBeNull();
			const [ tall, short ] = bands( container );
			expect( highestPoint( tall ) ).toBeCloseTo( CEILING, 3 );
			expect( highestPoint( short ) ).toBeGreaterThan( CEILING * 2 );
		} );

		it( 'keeps the caller default on a chart that declines the toggle', () => {
			window.localStorage.setItem( STACK_KEY, '0' );
			const { container } = mount( { stacked: true, stackable: false } );
			const [ bottom, top ] = bands( container );
			expect( highestPoint( top ) ).toBeCloseTo( CEILING, 3 );
			expect( highestPoint( bottom ) ).toBeGreaterThan( CEILING );
		} );
	} );

	it( 'refuses to draw without a storageKey', () => {
		const quiet = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			expect( () => mount( { storageKey: undefined } ) ).toThrow(
				'AreaTimeChart: storageKey'
			);
		} finally {
			quiet.mockRestore();
		}
	} );

	it( 'draws the caller-named Y title through the shared axes', () => {
		const { container } = mount( { yLabel: 'bytes' } );
		expect(
			container.querySelector( 'svg text.y-label' ).textContent
		).toBe( 'bytes' );
	} );
} );

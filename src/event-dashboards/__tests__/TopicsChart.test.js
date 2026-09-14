/**
 * TopicsChart — one Topics panel: the aligned probe model handed to the shared
 * `AreaTimeChart`, ranked busiest first and coloured by rank.
 *
 * Real d3 against jsdom, as the shared chart's own suite runs it; only the
 * tooltip is stubbed, to read the rows it would have printed.
 */

jest.mock( '@newspack-nodes/shared/hooks/useTimeChart', () => ( {
	__esModule: true,
	...jest.requireActual( '@newspack-nodes/shared/hooks/useTimeChart' ),
	setupTooltip: jest.fn(),
} ) );

import { render, fireEvent, act } from '@testing-library/react';
import { TopicsChart } from '../TopicsChart';
import {
	chartColor,
	setupTooltip,
} from '@newspack-nodes/shared/hooks/useTimeChart';

const legendRows = ( container ) => [
	...container.querySelectorAll( '.newspack-nodes-chart-legend li' ),
];
const legendLabels = ( container ) =>
	legendRows( container ).map( ( r ) => r.textContent );
const legendColors = ( container ) =>
	legendRows( container ).map(
		( r ) => r.querySelector( 'span[style]' ).style.background
	);
const bands = ( container ) =>
	[ ...container.querySelectorAll( 'svg path' ) ].filter( ( p ) =>
		p.style.fill.startsWith( 'var(' )
	);
const tooltipRows = ( idx ) =>
	setupTooltip.mock.calls.at( -1 )[ 1 ].formatEntry( idx );

const fmt = ( v ) => `${ v }/s`;
const series = {
	'low.p0': {
		points: [
			{ ts: 100, value: 1 },
			{ ts: 115, value: 2 },
		],
		max: 2,
		avg: 1.5,
	},
	'high.p0': {
		points: [
			{ ts: 100, value: 90 },
			{ ts: 115, value: 100 },
		],
		max: 100,
		avg: 95,
	},
};

const mount = ( props = {} ) =>
	render(
		<TopicsChart
			title="Rate"
			series={ series }
			formatValue={ fmt }
			{ ...props }
		/>
	);

beforeEach( () => setupTooltip.mockClear() );

describe( 'TopicsChart', () => {
	it( 'is a card carrying the shared chart, titled', () => {
		const { container } = mount();
		const panel = container.querySelector( '.nodes-topics' );
		expect( panel.classList.contains( 'newspack-nodes-card' ) ).toBe(
			true
		);
		expect(
			panel.querySelector( '.newspack-nodes-chart__title' ).textContent
		).toBe( 'Rate' );
		expect(
			panel.querySelector( '.newspack-nodes-chart__plot svg' )
		).not.toBeNull();
	} );

	it( 'ranks the legend busiest first and colours each rank by its skin token', () => {
		const { container } = mount();
		expect( legendLabels( container ) ).toEqual( [ 'high.p0', 'low.p0' ] );
		expect( legendColors( container ) ).toEqual( [
			chartColor( 0 ),
			chartColor( 1 ),
		] );
		expect( bands( container ).map( ( b ) => b.style.fill ) ).toEqual( [
			chartColor( 0 ),
			chartColor( 1 ),
		] );
	} );

	it( 'a picked topic is drawn alone, in the colour its rank gave it', () => {
		const { container } = mount();
		act( () =>
			fireEvent.click(
				legendRows( container )[ 1 ].querySelector( 'button' )
			)
		);
		const drawn = bands( container );
		expect( drawn ).toHaveLength( 1 );
		expect( drawn[ 0 ].style.fill ).toBe( chartColor( 1 ) );
		expect( tooltipRows( 0 ).map( ( e ) => e.label ) ).toEqual( [
			'low.p0',
		] );
	} );

	it( 'prints values through the caller formatter, busiest first, zeros dropped', () => {
		mount( {
			series: {
				...series,
				'idle.p0': {
					points: [
						{ ts: 100, value: 0 },
						{ ts: 115, value: 0 },
					],
					max: 0,
					avg: 0,
				},
			},
		} );
		expect( tooltipRows( 0 ) ).toEqual( [
			{ label: 'high.p0', value: '90/s', raw: 90 },
			{ label: 'low.p0', value: '1/s', raw: 1 },
		] );
	} );

	it( 'wipes the plot when the series goes empty, so a reset clears it', () => {
		const { container, rerender } = mount();
		expect( bands( container ) ).toHaveLength( 2 );
		rerender(
			<TopicsChart title="Rate" series={ {} } formatValue={ fmt } />
		);
		expect(
			container.querySelector( '.newspack-nodes-chart__plot svg' )
		).toBeNull();
		expect( legendRows( container ) ).toEqual( [] );
	} );

	it( 'overlays by default and stacks on the corner toggle', () => {
		const { container } = mount();
		const toggle = container.querySelector(
			'.newspack-nodes-chart__stack'
		);
		expect( toggle.getAttribute( 'aria-pressed' ) ).toBe( 'false' );
		act( () => fireEvent.click( toggle ) );
		expect( toggle.getAttribute( 'aria-pressed' ) ).toBe( 'true' );
		expect( bands( container ) ).toHaveLength( 2 );
	} );
} );

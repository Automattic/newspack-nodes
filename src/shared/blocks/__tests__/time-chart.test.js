/**
 * TimeChart — one panel: the aligned series model handed to the shared
 * `AreaTimeChart`, ranked busiest first and coloured by rank.
 *
 * Real d3 against jsdom, as the shared chart's own suite runs it; only the
 * tooltip is stubbed, to read the rows it would have printed.
 */

jest.mock( '../../hooks/useTimeChart', () => ( {
	__esModule: true,
	...jest.requireActual( '../../hooks/useTimeChart' ),
	setupTooltip: jest.fn(),
} ) );

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import * as sass from 'sass';
import postcss from 'postcss';
import { render, fireEvent, act } from '@testing-library/react';
import { TimeChart, TimeChartPanels } from '../time-chart';
import { chartColor, setupTooltip } from '../../hooks/useTimeChart';
import { axisDuration } from '../../utils/axis-ticks';

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
	},
	'high.p0': {
		points: [
			{ ts: 100, value: 90 },
			{ ts: 115, value: 100 },
		],
		max: 100,
	},
};

const mount = ( props = {} ) =>
	render(
		<TimeChart
			title="Rate"
			storageKey="test:topics-rate"
			series={ series }
			formatValue={ fmt }
			{ ...props }
		/>
	);

beforeEach( () => {
	setupTooltip.mockClear();
	window.localStorage.clear();
} );

describe( 'TimeChart', () => {
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

	it( 'titles its Y-axis with the label the caller names', () => {
		const { container } = mount( { yLabel: 'Messages' } );
		expect( container.querySelector( '.y-label' ).textContent ).toBe(
			'Messages'
		);
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
			<TimeChart
				title="Rate"
				storageKey="test:topics-rate"
				series={ {} }
				formatValue={ fmt }
			/>
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

	it( 'stacks by default when the caller says the series add up', () => {
		const { container } = mount( { stacked: true } );
		const toggle = container.querySelector(
			'.newspack-nodes-chart__stack'
		);
		expect( toggle.getAttribute( 'aria-pressed' ) ).toBe( 'true' );
		act( () => fireEvent.click( toggle ) );
		expect( toggle.getAttribute( 'aria-pressed' ) ).toBe( 'false' );
	} );

	it( 'leads a stacked tooltip with its own total row', () => {
		mount( { stacked: true } );
		expect( tooltipRows( 1 )[ 0 ] ).toEqual( {
			label: 'Total',
			value: '102/s',
		} );
	} );

	it( 'prints no total row while the bands overlay', () => {
		mount();
		expect( tooltipRows( 1 ).map( ( e ) => e.label ) ).toEqual( [
			'high.p0',
			'low.p0',
		] );
	} );

	it( 'ticks a latency panel peaking at 1.4 s in one unit, from its formatFor', () => {
		const { container } = render(
			<TimeChart
				title="Latency"
				storageKey="test:topics-latency"
				series={ {
					'cron:films': {
						points: [
							{ ts: 100, value: 250 },
							{ ts: 115, value: 1400 },
						],
						max: 1400,
					},
				} }
				formatFor={ axisDuration }
			/>
		);
		const yAxis = [ ...container.querySelectorAll( 'svg g' ) ].find(
			( g ) =>
				! g.getAttribute( 'transform' ) &&
				g.querySelector( ':scope > .tick' )
		);
		const ticks = [ ...yAxis.querySelectorAll( '.tick text' ) ].map(
			( t ) => t.textContent
		);
		expect( ticks.length ).toBeGreaterThan( 2 );
		for ( const tick of ticks ) {
			expect( tick ).toMatch( /^\d+(\.\d)?s$/ );
		}
	} );

	it( 'persists its corner choices under the storageKey it is handed', () => {
		const { container } = mount();
		fireEvent.click(
			container.querySelector( '.newspack-nodes-chart__expand' )
		);
		expect(
			window.localStorage.getItem( 'test:topics-rate:expanded' )
		).toBe( '1' );
	} );

	it( 'offers no stack toggle over means, which never add up', () => {
		const mean = { fill: 'zero', agg: 'mean' };
		const { container } = mount( {
			series: {
				'low.p0': { ...series[ 'low.p0' ], mode: mean },
				'high.p0': { ...series[ 'high.p0' ], mode: mean },
			},
		} );
		expect(
			container.querySelector( '.newspack-nodes-chart__stack' )
		).toBeNull();
	} );

	it( 'offers the stack toggle over rates', () => {
		const { container } = mount();
		expect(
			container.querySelector( '.newspack-nodes-chart__stack' )
		).not.toBeNull();
	} );
} );

describe( 'TimeChart axis cap', () => {
	// A half-row panel is about 900px, so 500 slots keep each above a pixel.
	it( 'buckets a long window into at most 500 slots', () => {
		const points = Array.from( { length: 4000 }, ( _, i ) => ( {
			ts: 100 + i * 15,
			value: i % 7,
		} ) );
		mount( { series: { 'long.p0': { points, max: 6 } } } );
		const { dates } = setupTooltip.mock.calls.at( -1 )[ 1 ];
		expect( dates.length ).toBeLessThanOrEqual( 500 );
		expect( dates.length ).toBeGreaterThan( 450 );
	} );
} );

describe( 'TimeChartPanels', () => {
	const gapped = ( mode ) => ( {
		'gap.p0': {
			points: [
				{ ts: 100, value: 50 },
				{ ts: 160, value: 70 },
			],
			max: 70,
			mode,
		},
	} );
	const panel = ( over = {} ) => ( {
		storageKey: `test:${ over.title ?? 'Held' }`,
		title: 'Held',
		yLabel: 'Bytes',
		series: gapped( { fill: 'hold', agg: 'last' } ),
		formatValue: fmt,
		...over,
	} );
	const mountPanels = ( panels ) =>
		render( <TimeChartPanels panels={ panels } /> );
	const midRows = () => {
		const { formatEntry } = setupTooltip.mock.calls.at( -1 )[ 1 ];
		return formatEntry( 1 );
	};

	it( 'draws one titled chart per declaration, in order', () => {
		const { container } = mountPanels( [
			panel( { title: 'First' } ),
			panel( { title: 'Second' } ),
		] );
		expect(
			[
				...container.querySelectorAll( '.newspack-nodes-chart__title' ),
			].map( ( t ) => t.textContent )
		).toEqual( [ 'First', 'Second' ] );
	} );

	it( 'keeps two panels sharing a title apart by their storageKeys', () => {
		const { container } = mountPanels( [
			panel( { title: 'Same', storageKey: 'test:first' } ),
			panel( { title: 'Same', storageKey: 'test:second' } ),
		] );
		const [ first, second ] = container.querySelectorAll(
			'.newspack-nodes-chart__expand'
		);
		fireEvent.click( first );
		expect( first.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
		expect( second.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
	} );

	it( 'lays every chart into the one grid wrapper it renders', () => {
		const { container } = mountPanels( [
			panel( { title: 'Left' } ),
			panel( { title: 'Right' } ),
			panel( { title: 'Below' } ),
		] );
		const grid = container.firstChild;
		expect( grid.className ).toBe( 'nodes-topics-panels' );
		expect( [ ...grid.children ].map( ( c ) => c.className ) ).toEqual(
			Array( 3 ).fill( 'newspack-nodes-card nodes-topics' )
		);
	} );

	it( 'fills each gap the way its series’ own mode says', () => {
		mountPanels( [ panel() ] );
		expect( midRows() ).toEqual( [
			{ label: 'gap.p0', value: '50/s', raw: 50 },
		] );
		setupTooltip.mockClear();
		mountPanels( [
			panel( { series: gapped( { fill: 'zero', agg: 'rate' } ) } ),
		] );
		expect( midRows() ).toEqual( [] );
	} );

	it( 'never stacks means, though asked to: overlaid bands and no total', () => {
		mountPanels( [
			panel( {
				title: 'Mean 7863',
				stacked: true,
				series: gapped( { fill: 'zero', agg: 'mean' } ),
			} ),
		] );
		const [ first ] = setupTooltip.mock.calls
			.at( -1 )[ 1 ]
			.formatEntry( 0 );
		expect( first.label ).toBe( 'gap.p0' );
	} );

	it( 'totals stacked panels alone', () => {
		mountPanels( [
			panel( { stacked: true } ),
			panel( {
				title: 'Mean',
				series: gapped( { fill: 'zero', agg: 'mean' } ),
			} ),
		] );
		const [ stacked, mean ] = setupTooltip.mock.calls.map(
			( c ) => c[ 1 ].formatEntry( 0 )[ 0 ].label
		);
		expect( stacked ).toBe( 'Total' );
		expect( mean ).toBe( 'gap.p0' );
	} );
} );

describe( 'TimeChart panel grid', () => {
	const sheet = resolvePath( __dirname, '../time-chart.scss' );
	const rule = ( selector ) => {
		const found = {};
		postcss
			.parse( sass.compile( sheet ).css, { from: sheet } )
			.walkRules( selector, ( r ) =>
				r.walkDecls( ( d ) => {
					found[ d.prop ] = d.value;
				} )
			);
		return found;
	};

	it( 'ships with the component that renders it', () => {
		expect(
			readFileSync( resolvePath( __dirname, '../time-chart.js' ), 'utf8' )
		).toContain( "import './time-chart.scss';" );
	} );

	it( 'lays the panels in columns that a drawn chart cannot widen', () => {
		// A chart SVG carries the width it measured, and a `1fr` track can
		// never be narrower than its content: the wider panel of a row would
		// pin its column, the other redraw to fit what was left, and every
		// poll ratchet the imbalance. `minmax(0, …)` takes content out of it.
		expect( rule( '.nodes-topics-panels' ) ).toEqual( {
			display: 'grid',
			'grid-template-columns': 'minmax(0, 1fr) minmax(0, 1fr)',
			gap: '12px',
			margin: '0 0 16px',
			'align-items': 'start',
		} );
	} );

	it( 'pads each panel inside its card', () => {
		expect( rule( '.nodes-topics' ) ).toEqual( { padding: '9px 11px' } );
	} );
} );

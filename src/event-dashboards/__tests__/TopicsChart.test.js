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
import {
	TopicsChart,
	TopicsPanels,
	ProbeTable,
	errorsColumn,
} from '../TopicsChart';
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

	it( 'offers no stack toggle when the caller marks the series unstackable', () => {
		const { container } = mount( { stackable: false } );
		expect(
			container.querySelector( '.newspack-nodes-chart__stack' )
		).toBeNull();
	} );
} );

describe( 'TopicsPanels', () => {
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
	const panel = ( over ) => ( {
		title: 'Held',
		yLabel: 'Bytes',
		series: gapped( { fill: 'hold', agg: 'last' } ),
		formatValue: fmt,
		...over,
	} );
	const mountPanels = ( panels ) =>
		render( <TopicsPanels panels={ panels } /> );
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

	it( 'totals stacked panels alone', () => {
		mountPanels( [
			panel( { stacked: true } ),
			panel( { title: 'Mean', stackable: false } ),
		] );
		const [ stacked, mean ] = setupTooltip.mock.calls.map(
			( c ) => c[ 1 ].formatEntry( 0 )[ 0 ].label
		);
		expect( stacked ).toBe( 'Total' );
		expect( mean ).toBe( 'gap.p0' );
	} );
} );

describe( 'ProbeTable', () => {
	const columns = [
		{
			label: 'Name',
			cell: ( row ) => row.key,
			td: () => ( { className: 'nodes-probe-tab__name' } ),
		},
		{
			label: 'Age',
			cell: ( row, ctx ) => `${ ctx.now - row.ts }s`,
			td: ( row ) => ( { title: `at ${ row.ts }` } ),
		},
	];
	const rows = [
		{ key: 'lab-7:kea.p3', ts: 4400 },
		{ key: 'lab-7:owl.p3', ts: 4471 },
	];
	const mountTable = ( over = {} ) =>
		render(
			<ProbeTable
				columns={ columns }
				rows={ rows }
				rowKey={ ( row ) => row.key }
				keyAttr="data-kea-key"
				context={ { now: 4500 } }
				emptyText="Nothing swept yet."
				{ ...over }
			/>
		);

	it( 'heads the canonical table with each column label', () => {
		const { container } = mountTable();
		const table = container.querySelector( 'table' );
		expect( table.className ).toBe(
			'nodes-probe-tab__table newspack-nodes-table'
		);
		expect(
			[ ...table.querySelectorAll( 'th' ) ].map( ( h ) => h.textContent )
		).toEqual( [ 'Name', 'Age' ] );
	} );

	it( 'renders a row per entry, keyed on the attribute it names', () => {
		const { container } = mountTable();
		const row = container.querySelector( '[data-kea-key="lab-7:owl.p3"]' );
		const cells = [ ...row.children ];
		expect( cells.map( ( c ) => c.textContent ) ).toEqual( [
			'lab-7:owl.p3',
			'29s',
		] );
		expect( cells[ 0 ].className ).toBe( 'nodes-probe-tab__name' );
		expect( cells[ 1 ].title ).toBe( 'at 4471' );
	} );

	it( 'shows its empty text in place of a table with no rows', () => {
		const { container } = mountTable( { rows: [] } );
		expect( container.querySelector( 'table' ) ).toBeNull();
		const empty = container.querySelector( '.nodes-probe-tab__empty' );
		expect( empty.className ).toBe(
			'newspack-nodes-empty-state nodes-probe-tab__empty'
		);
		expect( empty.textContent ).toBe( 'Nothing swept yet.' );
	} );
} );

describe( 'errorsColumn', () => {
	it( 'marks a nonzero count, and only a nonzero one', () => {
		const col = errorsColumn( 'Failures' );
		expect( col.label ).toBe( 'Failures' );
		expect( col.cell( { windowed: { errors: 4321 } } ) ).toBe( '4,321' );
		expect( col.td( { windowed: { errors: 7 } } ).className ).toBe(
			'nodes-probe-tab__count is-nonzero'
		);
		expect( col.td( { windowed: { errors: 0 } } ).className ).toBe(
			'nodes-probe-tab__count'
		);
	} );
} );

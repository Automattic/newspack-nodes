/**
 * TopicsChart — d3 multi-series area panel on the shared useTimeChart infra.
 * d3 is mocked with a chainable fluent builder, and useTimeChart is mocked to run
 * renderFn synchronously with real-ish refs (modeled on the event-logger's
 * CategoryTimeChart.test), so the render body runs without real SVG/RAF.
 */

jest.mock( 'd3', () => {
	// The chain is CALLABLE so a d3 scale invokes as x(d.date) in accessors.
	const chain = Object.assign(
		jest.fn( () => chain ),
		{}
	);
	[
		'select',
		'selectAll',
		'append',
		'attr',
		'style',
		'text',
		'datum',
		'remove',
		'call',
		'on',
		'ticks',
		'tickFormat',
		'domain',
		'range',
		'x',
		'y',
		'y0',
		'y1',
		'curve',
		'extent',
		'max',
		'area',
		'scaleTime',
		'scaleLinear',
		'axisBottom',
		'axisLeft',
	].forEach( ( fn ) => {
		chain[ fn ] = jest.fn( () => chain );
	} );
	// d3.max(arr, acc) runs acc per element; return numeric max for y domain.
	chain.max = jest.fn( ( arr, acc ) => {
		if ( ! Array.isArray( arr ) ) {
			return chain;
		}
		let m;
		arr.forEach( ( d, i ) => {
			const v = acc ? acc( d, i ) : d;
			if ( undefined === m || v > m ) {
				m = v;
			}
		} );
		return m;
	} );
	const handler = {
		get: ( _t, prop ) => {
			if ( prop === '__esModule' ) {
				return true;
			}
			if ( prop === '__chain' ) {
				return chain;
			}
			if ( chain[ prop ] !== undefined ) {
				return chain[ prop ];
			}
			const f = jest.fn( () => chain );
			chain[ prop ] = f;
			return f;
		},
	};
	return new Proxy( {}, handler );
} );

// Stashes the last renderFn so a test can re-invoke it with a null container.
const mockTimeChart = { lastRenderFn: null };

jest.mock( '@newspack-nodes/shared/hooks/useTimeChart', () => {
	const actual = jest.requireActual(
		'@newspack-nodes/shared/hooks/useTimeChart'
	);
	const { useEffect } = jest.requireActual( '@wordpress/element' );
	return {
		__esModule: true,
		...actual,
		setupTooltip: jest.fn(),
		drawLegend: jest.fn(),
		// Mirror the hook: run renderFn after commit so refs are populated.
		useTimeChart: ( renderFn ) => {
			mockTimeChart.lastRenderFn = renderFn;
			const containerRef = {
				current: {
					clientWidth: 800,
					parentElement: { clientHeight: 200 },
				},
			};
			const tooltipRef = { current: { style: {} } };
			const lastMouseXRef = { current: null };
			useEffect( () => {
				renderFn( { containerRef, tooltipRef, lastMouseXRef } );
				// Refs are stable per the real hook; only renderFn drives it.
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [ renderFn ] );
			return { containerRef, tooltipRef };
		},
	};
} );

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { render } from '@testing-library/react';
import * as d3 from 'd3';
import { TopicsChart } from '../TopicsChart';
import {
	PALETTE,
	drawLegend,
	setupTooltip,
} from '@newspack-nodes/shared/hooks/useTimeChart';

const fmt = ( v ) => `${ v }`;
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

describe( 'TopicsChart', () => {
	beforeEach( () => {
		drawLegend.mockClear();
		setupTooltip.mockClear();
		mockTimeChart.lastRenderFn = null;
	} );

	it( 'renders the title', () => {
		const { container } = render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		expect(
			container.querySelector( '.nodes-topics__title' ).textContent
		).toBe( 'Rate' );
	} );

	it( 'keeps the chart panel base and elevates only its tooltip', () => {
		const { container } = render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		const panel = container.querySelector( '.nodes-topics' );
		const tooltip = container.querySelector( '.nodes-topics__tooltip' );

		expect( panel.classList.contains( 'newspack-nodes-card' ) ).toBe(
			true
		);
		expect(
			panel.classList.contains( 'newspack-nodes-card--elevated' )
		).toBe( false );
		expect( tooltip.classList.contains( 'newspack-nodes-card' ) ).toBe(
			true
		);
		expect(
			tooltip.classList.contains( 'newspack-nodes-card--elevated' )
		).toBe( true );
	} );

	it( 'draws a legend ranked by max desc (busiest topic first) + a hover tooltip', () => {
		render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		expect( drawLegend ).toHaveBeenCalled();
		expect( setupTooltip ).toHaveBeenCalled();
		const items = drawLegend.mock.calls[ 0 ][ 1 ];
		expect( items.map( ( i ) => i.label ) ).toEqual( [
			'high.p0',
			'low.p0',
		] );
	} );

	it( 'does not draw when there is no data', () => {
		render(
			<TopicsChart title="Rate" series={ {} } formatValue={ fmt } />
		);
		expect( drawLegend ).not.toHaveBeenCalled();
	} );

	it( 'wipes the canvas when the series goes empty (so a reset clears old lines)', () => {
		d3.remove.mockClear();
		render(
			<TopicsChart title="Rate" series={ {} } formatValue={ fmt } />
		);
		// Empty series still clears any prior render instead of bailing first.
		expect( d3.remove ).toHaveBeenCalled();
		expect( drawLegend ).not.toHaveBeenCalled();
	} );

	it( 'colors series from the active theme --chart-* tokens when present', () => {
		const tokens = {
			'--chart-1': '#aa1111',
			'--chart-2': '#bb2222',
			'--chart-3': '#cc3333',
			'--chart-4': '#dd4444',
			'--chart-5': '#ee5555',
			'--chart-6': '#ff6666',
			'--chart-7': '#117777',
			'--chart-8': '#228888',
		};
		const original = window.getComputedStyle;
		window.getComputedStyle = () => ( {
			getPropertyValue: ( n ) => tokens[ n ] ?? '',
		} );
		try {
			render(
				<TopicsChart
					title="Rate"
					series={ series }
					formatValue={ fmt }
				/>
			);
		} finally {
			window.getComputedStyle = original;
		}
		// Legend is ranked busiest-first: high.p0 (idx 0) then low.p0 (idx 1).
		const items = drawLegend.mock.calls[ 0 ][ 1 ];
		expect( items.map( ( i ) => i.color ) ).toEqual( [
			'#aa1111',
			'#bb2222',
		] );
	} );

	it( 'falls back to the shared PALETTE colors when the theme tokens are absent', () => {
		const original = window.getComputedStyle;
		window.getComputedStyle = () => ( {
			getPropertyValue: () => '',
		} );
		try {
			render(
				<TopicsChart
					title="Rate"
					series={ series }
					formatValue={ fmt }
				/>
			);
		} finally {
			window.getComputedStyle = original;
		}
		const items = drawLegend.mock.calls[ 0 ][ 1 ];
		expect( items.map( ( i ) => i.color ) ).toEqual( [
			PALETTE[ 0 ],
			PALETTE[ 1 ],
		] );
	} );

	it( 'bails out when the chart container ref is not yet mounted', () => {
		render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		drawLegend.mockClear();
		setupTooltip.mockClear();
		// Re-invoke renderFn with a null container: must return before drawing.
		mockTimeChart.lastRenderFn( {
			containerRef: { current: null },
			tooltipRef: { current: { style: {} } },
			lastMouseXRef: { current: null },
		} );
		expect( drawLegend ).not.toHaveBeenCalled();
		expect( setupTooltip ).not.toHaveBeenCalled();
	} );

	it( 'builds the hover tooltip entries ranked by value desc, dropping zeros', () => {
		render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		const { formatEntry } = setupTooltip.mock.calls[ 0 ][ 1 ];
		const entries = formatEntry( 0 );
		// Both topics have a positive value at index 0; busiest first.
		expect( entries.map( ( e ) => e.label ) ).toEqual( [
			'high.p0',
			'low.p0',
		] );
		expect( entries.every( ( e ) => e.raw > 0 ) ).toBe( true );
	} );

	it( 'draws its axes through the shared frame, not a private copy', () => {
		const source = readFileSync(
			resolvePath( __dirname, '../TopicsChart.js' ),
			'utf8'
		);
		expect( source ).toContain( 'drawAxes' );
		expect( source ).not.toContain( 'axisBottom' );
		expect( source ).not.toContain( 'axisLeft' );
	} );

	it( 'wires d3 area/axis accessors that read the scaled point fields', () => {
		render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		// Invoke the captured area x/y1 + tickFormat callbacks so bodies run.
		const areaX = d3.x.mock.calls[ 0 ][ 0 ];
		const areaY1 = d3.y1.mock.calls[ 0 ][ 0 ];
		// Each accessor must route its field through the scale, not raw/undef.
		expect( areaX( { date: new Date( 1000 ) } ) ).toBe( d3.__chain );
		expect( areaY1( { value: 5 } ) ).toBe( d3.__chain );
		// tickFormat called for both axes; 2nd call is the y-axis formatter.
		const yTickFormat = d3.tickFormat.mock.calls[ 1 ][ 0 ];
		expect( yTickFormat( 42 ) ).toBe( '42' );
	} );
} );

/**
 * TopicsChart — d3 multi-series area panel on the shared useTimeChart infra.
 * d3 is mocked with a chainable fluent builder, and useTimeChart is mocked to run
 * renderFn synchronously with real-ish refs (modeled on the event-logger's
 * CategoryTimeChart.test), so the render body runs without real SVG/RAF.
 */

jest.mock( 'd3', () => {
	// The chain is itself CALLABLE so a d3 scale (`x = scaleTime()…`) can be
	// invoked as `x( d.date )` inside an area/axis accessor without throwing.
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
	// Real `d3.max( arr, accessor )` invokes the accessor per element; the
	// default `() => chain` stub would leave those accessors uncovered, so run
	// them and return the numeric max (callers only use it for the y domain).
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

// The mock stashes the last renderFn here so a test can re-invoke it with a
// null container (React always re-populates the JSX ref, so the unmounted-ref
// guard can't be reached through a normal render). `mock`-prefixed so the
// jest.mock factory below may close over it.
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
		// Mirror the real hook's timing: run renderFn in an effect AFTER commit
		// so the JSX refs (including TopicsChart's themeRef) are populated.
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
		// Re-invoke the captured renderFn with a null container (an unmounted /
		// not-yet-attached ref): it must return before drawing anything.
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

	it( 'wires d3 area/axis accessors that read the scaled point fields', () => {
		render(
			<TopicsChart title="Rate" series={ series } formatValue={ fmt } />
		);
		// The area x/y1 accessors and the y-axis tickFormat are passed to the
		// (mocked) d3 builders; invoke the captured callbacks so their bodies run.
		const areaX = d3.x.mock.calls[ 0 ][ 0 ];
		const areaY1 = d3.y1.mock.calls[ 0 ][ 0 ];
		// Each accessor must route its point field THROUGH the d3 scale and return the
		// scale's output (the mocked chainable scale), not the raw field or undefined —
		// `( d ) => x( d.date )` / `( d ) => y( d.value )`. A bare not.toThrow would
		// pass even if the accessor forgot to scale; asserting the scale's return value
		// catches that.
		expect( areaX( { date: new Date( 1000 ) } ) ).toBe( d3.__chain );
		expect( areaY1( { value: 5 } ) ).toBe( d3.__chain );
		// tickFormat is called for both axes; the second call is the y-axis
		// value formatter `( v ) => formatValue( v )`.
		const yTickFormat = d3.tickFormat.mock.calls[ 1 ][ 0 ];
		expect( yTickFormat( 42 ) ).toBe( '42' );
	} );
} );

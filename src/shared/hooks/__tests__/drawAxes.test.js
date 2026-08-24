/**
 * drawAxes tests — real d3 against jsdom, so the assertions read the SVG the
 * charts actually get rather than a mocked selection chain.
 */

import * as d3 from 'd3';
import { MARGIN, drawAxes, formatXTick } from '../useTimeChart';

const INNER_H = 133;

/**
 * Draw the frame into a detached SVG and hand back the inner group.
 *
 * @param {Object} params Extra `drawAxes` params merged over the defaults.
 * @return {Element} The `<g>` the axes were drawn into.
 */
function frame( params = {} ) {
	const svg = d3.select( document.createElement( 'div' ) ).append( 'svg' );
	const g = svg.append( 'g' );
	const x = d3
		.scaleTime()
		.domain( [
			new Date( 2026, 4, 19, 14, 0 ),
			new Date( 2026, 4, 19, 20 ),
		] )
		.range( [ 0, 640 ] );
	const y = d3.scaleLinear().domain( [ 0, 900 ] ).range( [ INNER_H, 0 ] );
	drawAxes( g, {
		x,
		y,
		innerH: INNER_H,
		tickCount: 37,
		yFormat: ( v ) => `${ v }u`,
		...params,
	} );
	return g.node();
}

/**
 * The time axis's tick labels, in draw order.
 *
 * @param {Element} g The group `drawAxes` drew into.
 * @return {Array<Element>} The bottom axis's `<text>` nodes.
 */
function timeLabels( g ) {
	const bottom = [ ...g.querySelectorAll( 'g' ) ].find(
		( group ) =>
			group.getAttribute( 'transform' ) === `translate(0,${ INNER_H })`
	);
	return [ ...bottom.querySelectorAll( 'g.tick text' ) ];
}

describe( 'drawAxes', () => {
	it( 'offsets the time axis to the bottom of the plot', () => {
		const groups = [ ...frame().querySelectorAll( 'g' ) ];
		const bottom = groups.find(
			( group ) =>
				group.getAttribute( 'transform' ) ===
				`translate(0,${ INNER_H })`
		);
		expect( bottom ).toBeTruthy();
	} );

	it( 'caps the time axis at 8 ticks and formats them as M/D HH:MM', () => {
		const labels = timeLabels( frame() );
		expect( labels.length ).toBeLessThanOrEqual( 8 );
		expect( labels.length ).toBeGreaterThan( 1 );
		expect( labels[ 0 ].textContent ).toMatch( /^\d+\/\d+ \d+:\d{2}$/ );
		expect( labels[ 0 ].textContent ).toBe(
			formatXTick( new Date( labels[ 0 ].__data__ ) )
		);
	} );

	it( 'asks for the slot count when it sits under the cap', () => {
		expect( timeLabels( frame( { tickCount: 2 } ) ).length ).toBeLessThan(
			timeLabels( frame() ).length
		);
	} );

	it( 'rotates every time-axis label 45 degrees and anchors it at the end', () => {
		const labels = timeLabels( frame() );
		labels.forEach( ( label ) => {
			expect( label.getAttribute( 'transform' ) ).toBe( 'rotate(-45)' );
			expect( label.style.textAnchor ).toBe( 'end' );
		} );
	} );

	it( 'draws the value axis with 5 ticks through the caller format', () => {
		const left = [ ...frame().querySelectorAll( 'g' ) ].find(
			( group ) => ! group.getAttribute( 'transform' )
		);
		const labels = [ ...left.querySelectorAll( 'g.tick text' ) ];
		expect( labels.length ).toBeGreaterThan( 3 );
		expect( labels.every( ( l ) => l.textContent.endsWith( 'u' ) ) ).toBe(
			true
		);
	} );

	it( 'draws the rotated Y title at the left margin, centred on the plot', () => {
		const label = frame( { yLabel: 'Widgets' } ).querySelector(
			'text.y-label'
		);
		expect( label.textContent ).toBe( 'Widgets' );
		expect( label.getAttribute( 'transform' ) ).toBe( 'rotate(-90)' );
		expect( label.getAttribute( 'y' ) ).toBe( String( 0 - MARGIN.left ) );
		expect( label.getAttribute( 'x' ) ).toBe( String( 0 - INNER_H / 2 ) );
		expect( label.getAttribute( 'dy' ) ).toBe( '1em' );
	} );

	it( 'leaves the value axis unlabelled when no title is given', () => {
		expect( frame().querySelector( 'text.y-label' ) ).toBeNull();
	} );
} );

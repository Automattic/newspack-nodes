/**
 * drawAxes tests — real d3 against jsdom, so the assertions read the SVG the
 * charts actually get rather than a mocked selection chain.
 */

import * as d3 from 'd3';
import { MARGIN, drawAxes, formatXTick } from '../useTimeChart';
import { integerTicks } from '../../utils/axis-ticks';
import { formatBytes } from '../../utils/formatters';

const INNER_H = 133;

/**
 * Draw the frame into a detached SVG and hand back the inner group.
 *
 * @param {Object}   params         Extra `drawAxes` params merged over the defaults.
 * @param {number[]} params.yDomain Value-scale domain.
 * @return {Element} The `<g>` the axes were drawn into.
 */
function frame( { yDomain = [ 0, 900 ], ...params } = {} ) {
	const svg = d3.select( document.createElement( 'div' ) ).append( 'svg' );
	const g = svg.append( 'g' );
	const x = d3
		.scaleTime()
		.domain( [
			new Date( 2026, 4, 19, 14, 0 ),
			new Date( 2026, 4, 19, 20 ),
		] )
		.range( [ 0, 640 ] );
	const y = d3.scaleLinear().domain( yDomain ).range( [ INNER_H, 0 ] );
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

/**
 * The value axis's tick labels, in draw order.
 *
 * @param {Element} g The group `drawAxes` drew into.
 * @return {Array<string>} The left axis's rendered label text.
 */
function valueLabels( g ) {
	const left = [ ...g.querySelectorAll( 'g' ) ].find(
		( group ) => ! group.getAttribute( 'transform' )
	);
	return [ ...left.querySelectorAll( 'g.tick text' ) ].map(
		( text ) => text.textContent
	);
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

	it( 'ticks a byte axis in whole binary units', () => {
		const labels = valueLabels(
			frame( { yDomain: [ 0, 4_600_000 ], yFormat: formatBytes } )
		);
		expect( labels ).toEqual( [ '0 B', '1 MB', '2 MB', '3 MB', '4 MB' ] );
	} );

	it( 'ticks a whole-unit axis in whole units, so no label repeats', () => {
		const yFormat = ( v ) => `${ v } runs`;
		yFormat.tickValues = integerTicks;
		const labels = valueLabels( frame( { yDomain: [ 0, 3.3 ], yFormat } ) );
		expect( labels ).toEqual( [ '0 runs', '1 runs', '2 runs', '3 runs' ] );
	} );

	it( 'leaves a formatter with no ladder on d3 base-10 ticks', () => {
		expect( valueLabels( frame() ) ).toEqual( [
			'0u',
			'200u',
			'400u',
			'600u',
			'800u',
		] );
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

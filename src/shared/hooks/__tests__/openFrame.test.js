/**
 * openFrame tests — real d3 against jsdom, so the assertions read the SVG the
 * three charts actually get rather than a mocked selection chain.
 *
 * The markup assertions are characterization: they pin the element order,
 * transform string and width/height attributes the hand-rolled frame blocks
 * emitted, so collapsing them into one helper cannot move a pixel.
 */

import * as d3 from 'd3';
import { MARGIN, openFrame } from '../useTimeChart';

const WIDTH = 1176;
const HEIGHT = 317;

/**
 * A detached container reporting a fixed `clientWidth`; jsdom measures 0.
 *
 * @param {number} [clientWidth] Width the container should report.
 * @return {Element} The container div.
 */
function container( clientWidth = WIDTH ) {
	const el = document.createElement( 'div' );
	Object.defineProperty( el, 'clientWidth', { value: clientWidth } );
	return el;
}

describe( 'openFrame', () => {
	it( 'emits an svg sized to the container holding one offset group', () => {
		const el = container();
		openFrame( el, HEIGHT );
		expect( el.innerHTML ).toBe(
			`<svg width="${ WIDTH }" height="${ HEIGHT }">` +
				`<g transform="translate(${ MARGIN.left },${ MARGIN.top })">` +
				'</g></svg>'
		);
	} );

	it( 'reports the outer width and the margin-inset plot box', () => {
		const { width, innerW, innerH } = openFrame( container(), HEIGHT );
		expect( width ).toBe( WIDTH );
		expect( innerW ).toBe( WIDTH - MARGIN.left - MARGIN.right );
		expect( innerH ).toBe( HEIGHT - MARGIN.top - MARGIN.bottom );
	} );

	it( 'hands back selections of the emitted svg and group', () => {
		const el = container();
		const { svg, g } = openFrame( el, HEIGHT );
		expect( svg.node() ).toBe( el.querySelector( 'svg' ) );
		expect( g.node() ).toBe( el.querySelector( 'svg > g' ) );
	} );

	it( 'falls back to 800 wide when the container measures nothing', () => {
		expect( openFrame( container( 0 ), HEIGHT ).width ).toBe( 800 );
	} );

	it( 'wipes the previous render before drawing', () => {
		const el = container();
		d3.select( el ).append( 'svg' ).attr( 'id', 'stale' );
		openFrame( el, HEIGHT );
		expect( el.querySelectorAll( 'svg' ).length ).toBe( 1 );
		expect( el.querySelector( '#stale' ) ).toBeNull();
	} );

	it( 'emits the same frame at every caller height', () => {
		// 280 AggregateTimeChart, 250 ResponseTimeChart, 200 Category/Topics.
		[ 280, 250, 200 ].forEach( ( height ) => {
			const el = container();
			openFrame( el, height );
			expect( el.innerHTML ).toBe(
				`<svg width="${ WIDTH }" height="${ height }">` +
					'<g transform="translate(60,20)"></g></svg>'
			);
		} );
	} );
} );

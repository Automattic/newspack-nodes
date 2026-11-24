/**
 * The force canvas's paint: the tokens each class of `forceGraphModel` wears,
 * and what outranks what. The component's own sheet and the console's ship in
 * two files that load in either order, so each is read both ways round.
 */

import path from 'path';
import * as sass from 'sass';
import postcss from 'postcss';

const read = require( '../../../build-kit/css-reader.cjs' );

const SRC = path.resolve( __dirname, '../../..' );
const PARTIAL = path.join( SRC, 'topology-console/styles/_force-graph.scss' );
const compile = ( file ) =>
	postcss.parse( sass.compile( path.join( SRC, file ) ).css );
const OWN = compile( 'shared/forceGraph/ForceGraph.scss' );
const CONSOLE = compile( 'topology-console/styles/graph-view.scss' );
// jsdom does not read `:has( > … )`; the rule settles what takes a press.
OWN.walkRules( /:has\(/, ( rule ) => rule.remove() );
const FOCUS = compile( 'shared/styles/_focus.scss' );
const ORDERS = [
	[ OWN, CONSOLE ],
	[ CONSOLE, OWN ],
];
const BLOCK = 'newspack-nodes-force-graph';

/**
 * One element of a canvas, and what both load orders make of it.
 *
 * @param {string} part The element, under the console and the svg.
 * @param {string} at   A selector of it.
 * @return {function(string): string} A longhand's winning value.
 */
const paint = ( part, at ) => {
	document.body.innerHTML = `
		<main class="topology-app"><div class="topology-canvas">
			<svg class="${ BLOCK } topology-force-canvas">
				<g class="${ BLOCK }__view">${ part }</g>
			</svg>
		</div></main>`;
	const el = document.querySelector( at );
	return ( longhand ) => {
		const [ one, two ] = ORDERS.map( ( sheets ) =>
			read.winning( el, longhand, sheets )
		);
		expect( two ).toBe( one );
		return one;
	};
};

const NODE = `.${ BLOCK }__node`;
const node = ( names, at = NODE ) =>
	paint(
		`<g class="${ BLOCK }__node ${ names }">
			<rect class="${ BLOCK }__shape"></rect>
			<text class="${ BLOCK }__label">vat-33</text>
		</g>`,
		at
	);
const shape = ( names ) => node( names, `.${ BLOCK }__shape` );
const label = ( names ) => node( names, `.${ BLOCK }__label` );
const line = ( names ) =>
	paint( `<path class="${ BLOCK }__link ${ names }">`, `.${ BLOCK }__link` );
const hull = ( names ) =>
	paint( `<path class="${ BLOCK }__hull ${ names }">`, `.${ BLOCK }__hull` );

describe( 'the canvas', () => {
	it( 'draws the grid over the frame’s wash, above the title block', () => {
		const svg = paint( '', 'svg' );
		expect( svg( 'background-image' ) ).toContain( 'var(--grid)' );
		expect( svg( 'background-size' ) ).toBe( '120px 55px' );
		expect( svg( 'background-color' ) ).toBeUndefined();
		expect( svg( 'z-index' ) ).toBe( '1' );
		expect( svg( 'position' ) ).toBe( 'relative' );
	} );

	it( 'insets its focus ring, as its host clips one', () => {
		const inset = [];
		FOCUS.walkDecls( 'outline-offset', ( { value, parent } ) => {
			if ( '-2px' === value ) {
				inset.push( ...parent.selectors );
			}
		} );
		expect( inset ).toContain(
			'.newspack-nodes-ui.newspack-nodes-ui .topology-force-canvas:focus-visible'
		);
	} );
} );

describe( 'a line', () => {
	it.each( [
		[ 'is-target', 'var(--cyan)', undefined ],
		[ 'is-virtual', 'var(--brass-dark)', undefined ],
		[ 'is-registration', 'var(--sage-dark)', undefined ],
		[ 'is-sink', 'var(--ink-3)', undefined ],
		[ 'is-patron', 'var(--ink-3)', '4 3' ],
	] )( '%s is drawn in %s, dashed %s', ( kind, stroke, dash ) => {
		const drawn = line( kind );
		expect( drawn( 'stroke' ) ).toBe( stroke );
		expect( drawn( 'stroke-dasharray' ) ).toBe( dash );
		expect( drawn( 'opacity' ) ).toBeUndefined();
	} );

	it.each( [
		[ 'is-touched', 'var(--oxide)', '1' ],
		[ 'is-lit', 'var(--cyan)', '1' ],
		[ 'is-dimmed', 'var(--cyan)', '0.15' ],
		[ 'is-selected', 'var(--oxide)', '1' ],
		[ 'is-lit is-dimmed', 'var(--cyan)', '0.15' ],
		[ 'is-touched is-lit is-dimmed', 'var(--oxide)', '0.15' ],
	] )( 'that %s is drawn in %s at opacity %s', ( state, stroke, opacity ) => {
		const drawn = line( `is-target ${ state }` );
		expect( drawn( 'stroke' ) ).toBe( stroke );
		expect( drawn( 'opacity' ) ).toBe( opacity );
	} );

	it( 'that is selected is as wide as the schematic’s', () => {
		const selected = line( 'is-target is-selected' );
		expect( selected( 'stroke-width' ) ).toBe( '2.6' );
	} );

	it( 'with traffic takes its opacity and width from its attributes', () => {
		const drawn = line( 'is-target is-live' );
		expect( drawn( 'opacity' ) ).toBeUndefined();
		expect( drawn( 'stroke-width' ) ).toBeUndefined();
	} );
} );

describe( 'a target for a press', () => {
	const hit = () =>
		paint( `<path class="${ BLOCK }__hit">`, `.${ BLOCK }__hit` );
	const schematic = () =>
		paint( '<path class="topology-edge-hit">', '.topology-edge-hit' );

	it.each( [
		[ 'stroke-width', '14' ],
		[ 'stroke', 'transparent' ],
		[ 'fill', 'none' ],
		[ 'cursor', 'pointer' ],
		[ 'vector-effect', undefined ],
	] )( 'has the schematic’s %s, %s', ( longhand, value ) => {
		expect( hit()( longhand ) ).toBe( value );
		expect( schematic()( longhand ) ).toBe( value );
	} );
} );

describe( 'a node', () => {
	it( 'is drawn on paper in ink', () => {
		expect( shape( '' )( 'fill' ) ).toMatch( /^var\(--paper-2\b/ );
		expect( shape( '' )( 'stroke' ) ).toBe( 'var(--ink)' );
		expect( label( '' )( 'fill' ) ).toMatch( /^var\(--ink,/ );
		expect( shape( '' )( 'filter' ) ).toBeUndefined();
	} );

	it.each( [
		[ '', undefined ],
		[ 'is-idle', '0.55' ],
		[ 'is-lit', undefined ],
		[ 'is-dimmed', '0.4' ],
		[ 'is-idle is-dimmed', '0.4' ],
		[ 'is-lit is-dimmed', '0.4' ],
	] )( 'that %s is at opacity %s', ( state, opacity ) => {
		expect( node( state )( 'opacity' ) ).toBe( opacity );
	} );

	it( 'with traffic brightens and glows', () => {
		const live = shape( 'is-live' );
		expect( live( 'fill' ) ).toMatch( /^color-mix\(.*var\(--cyan\)/ );
		expect( live( 'stroke' ) ).toBe( 'var(--cyan)' );
		expect( live( 'filter' ) ).toMatch( /^drop-shadow\(.*var\(--cyan\)/ );
	} );

	it( 'that is drift is dashed in brass, hovered or live', () => {
		for ( const state of [ '', 'is-hovered', 'is-live' ] ) {
			const drift = shape( `is-drift ${ state }` );
			expect( drift( 'stroke' ) ).toBe( 'var(--brass)' );
			expect( drift( 'stroke-dasharray' ) ).toBe( '5 3' );
			expect( drift( 'stroke-width' ) ).toBe( '2' );
		}
	} );

	it.each( [ '', 'is-hovered', 'is-live', 'is-drift', 'is-lit' ] )(
		'that is selected takes an oxide border, %s or not',
		( state ) => {
			const selected = shape( `is-selected ${ state }` );
			expect( selected( 'stroke' ) ).toBe( 'var(--oxide)' );
			expect( selected( 'stroke-width' ) ).toBe( '2' );
		}
	);

	it.each( [ 'is-hovered', 'is-lit' ] )( 'that %s is shaded', ( state ) => {
		expect( shape( state )( 'fill' ) ).toMatch(
			/^color-mix\(.*var\(--ink\).*var\(--paper-2\)/
		);
	} );

	it( 'that is a sidecar is drawn smaller, and stands where it stood', () => {
		for ( const part of [ shape, label ] ) {
			expect( part( 'is-sidecar' )( 'transform' ) ).toBe( 'scale(0.8)' );
			expect( part( '' )( 'transform' ) ).toBeUndefined();
		}
		expect( node( 'is-sidecar' )( 'transform' ) ).toBeUndefined();
	} );
} );

describe( 'a hull', () => {
	it( 'takes its color from the partial of the force canvas', () => {
		const colored = [];
		postcss
			.parse( sass.compile( PARTIAL ).css )
			.walkRules( ( rule ) =>
				colored.push(
					...rule.selectors.filter( ( s ) => /hull/.test( s ) )
				)
			);
		expect( colored ).toEqual(
			[ 1, 2, 3, 4, 5, 6 ].map(
				( i ) => `.topology-force-canvas .is-hull-${ i }`
			)
		);
	} );

	it.each( [ 1, 2, 3, 4, 5, 6 ] )(
		'is-hull-%i takes the schematic’s color of that index',
		( i ) => {
			const drawn = hull( `is-hull-${ i }` );
			const schematic = paint(
				`<path class="topology-hull topology-hull--${ i - 1 }">`,
				'.topology-hull'
			);
			const color = `var(--chart-${ i })`;
			for ( const longhand of [ 'fill', 'stroke' ] ) {
				expect( schematic( longhand ) ).toBe( color );
				expect( hull( `is-hull-${ i } is-selected` )( longhand ) ).toBe(
					color
				);
				expect( drawn( longhand ) ).toBe( color );
			}
		}
	);
} );

it( 'paints by tokens alone, and leaves every box and label as measured', () => {
	const decls = [];
	postcss.parse( sass.compile( PARTIAL ).css ).walkDecls( ( decl ) => {
		expect( decl.important ).toBeFalsy();
		decls.push( decl );
	} );
	expect( decls.length ).toBeGreaterThan( 20 );
	for ( const { prop, value } of decls ) {
		expect( value ).not.toMatch( /#[0-9a-f]{3}|rgba?\(|hsla?\(/i );
		expect( prop ).not.toMatch(
			/^(width|height|x|y|r|rx|ry|font.*|letter-spacing)$/
		);
	}
} );

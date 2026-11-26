/* @jest-environment node */

/**
 * Tests for the colored paint a host includes on its canvas: each node's
 * circle in the color its class names, the lines at rest, zoomed out, lit and
 * dimmed, and what a selection rings and dims.
 */

import path from 'node:path';
import postcss from 'postcss';
import * as sass from 'sass';

const { sassImporter } = require( '../../../build-kit/alias-map.cjs' );

const SRC = path.resolve( __dirname, '../../..' );
const PAINT = '@newspack-nodes/shared/forceGraph/paint';
const G = '.newspack-nodes-force-graph';
const LINE = 'var(--ink-3, var(--np-text-secondary))';
const PAPER = 'var(--paper-2, var(--np-surface-subtle))';
const INK = 'var(--ink, var(--np-text))';

/**
 * The sheet the mixin writes for these colors on a `.host` canvas.
 *
 * @param {string} colors A Sass map of node class to color.
 * @return {string} The CSS.
 */
const compiled = ( colors ) =>
	sass.compileString(
		`@use "${ PAINT }" as graph; .host { @include graph.paint(${ colors }); }`,
		{ importers: [ sassImporter( SRC ) ] }
	).css;

/**
 * Each declaration the mixin writes for these colors, keyed by its
 * selector, then by its property.
 *
 * @param {string} colors A Sass map of node class to color.
 * @return {Object<string, Object<string, string>>} The declarations.
 */
const painted = ( colors ) => {
	const css = compiled( colors );
	const found = {};
	postcss.parse( css ).walkDecls( ( { prop, value, parent } ) => {
		parent.selectors.forEach( ( selector ) => {
			found[ selector ] = { ...found[ selector ], [ prop ]: value };
		} );
	} );
	return found;
};

const mix = ( a, share, b ) => `color-mix(in srgb, ${ a } ${ share }%, ${ b })`;
const lightDark = ( light, dark ) => `light-dark(${ light }, ${ dark })`;

describe( 'the colored paint', () => {
	const rules = painted( '("": tomato, ".is-type-2": teal)' );

	it( 'fills and rings each node’s circle in its color, alike under every scheme', () => {
		[
			[ '', 'tomato' ],
			[ '.is-type-2', 'teal' ],
		].forEach( ( [ names, color ] ) => {
			expect(
				rules[ `.host ${ G }__node${ names } ${ G }__shape` ]
			).toEqual( {
				fill: mix( color, 35, PAPER ),
				stroke: mix( color, 35, INK ),
			} );
			expect(
				rules[
					`.host ${ G }__view.is-far ${ G }__node${ names } ${ G }__shape`
				]
			).toEqual( {
				fill: lightDark(
					mix( color, 85, PAPER ),
					mix( color, 85, INK )
				),
			} );
		} );
	} );

	it( 'rings a hovered or selected circle in the ink and dims what a selection leaves', () => {
		[ 'is-hovered', 'is-selected' ].forEach( ( state ) =>
			expect(
				rules[ `.host ${ G }__node.${ state } ${ G }__shape` ]
			).toEqual( { stroke: INK } )
		);
		expect( rules[ `.host ${ G }__node.is-dimmed` ] ).toEqual( {
			opacity: '0.25',
		} );
	} );

	it( 'draws a line faint at rest, stronger zoomed out, in the accent lit', () => {
		const line = ( share ) => mix( LINE, share, 'transparent' );
		expect( rules[ `.host ${ G }__link` ] ).toEqual( {
			stroke: lightDark( line( 35 ), line( 50 ) ),
		} );
		expect( rules[ `.host ${ G }__link.is-lit` ] ).toEqual( {
			stroke: 'var(--cyan, var(--np-primary))',
		} );
		expect( rules[ `.host ${ G }__link.is-dimmed` ] ).toEqual( {
			stroke: lightDark( line( 10 ), line( 20 ) ),
		} );
		expect(
			rules[
				`.host ${ G }__view.is-far ${ G }__link:not(.is-lit, .is-dimmed)`
			]
		).toEqual( { stroke: lightDark( line( 45 ), line( 85 ) ) } );
	} );

	it( 'rings a hovered or selected circle after every color, so the ring wins', () => {
		const css = compiled( '("": tomato)' );
		[ '.is-hovered', '.is-selected' ].forEach( ( state ) =>
			expect( css.indexOf( state ) ).toBeGreaterThan(
				css.lastIndexOf( 'tomato' )
			)
		);
	} );
} );

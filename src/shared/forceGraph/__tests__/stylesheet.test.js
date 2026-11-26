/* @jest-environment node */

/**
 * Tests for what the force graph's stylesheet lets a press reach, and for the
 * skeleton it paints.
 */

import path from 'node:path';
import postcss from 'postcss';
import * as sass from 'sass';

const FILE = path.resolve( __dirname, '../ForceGraph.scss' );
const UI = path.resolve( __dirname, '../../../ui/newspack-nodes-ui.scss' );
const BLOCK = '.newspack-nodes-force-graph';

it( 'lets a press through a hull’s label and a mute line alone', () => {
	const through = [];
	postcss
		.parse( sass.compile( FILE ).css )
		.walkDecls( 'pointer-events', ( { value, parent } ) => {
			expect( value ).toBe( 'none' );
			through.push( ...parent.selectors );
		} );
	expect( through.sort() ).toEqual( [
		`${ BLOCK }__hull-label`,
		`${ BLOCK }__link:not(.is-pressable):not(:has(> title))`,
	] );
} );

describe( 'the skeleton', () => {
	const OWN = postcss.parse( sass.compile( FILE ).css );
	const SHARED = postcss.parse( sass.compile( UI ).css );
	const PULSE = [ 'background', 'background-size', 'animation' ];

	// What each rule whose selector ends so declares of some properties.
	const declared = ( sheet, end, props ) => {
		const found = [];
		sheet.walkRules( ( rule ) => {
			if ( rule.selectors.some( ( one ) => one.endsWith( end ) ) ) {
				const { name = '', params = '' } = rule.parent;
				rule.walkDecls( ( { prop, value } ) => {
					if ( props.includes( prop ) ) {
						found.push( [ name + params, prop, value ] );
					}
				} );
			}
		} );
		return found;
	};
	const pulses = ( sheet ) => {
		const found = [];
		sheet.walkAtRules( 'keyframes', ( rule ) =>
			found.push( String( rule ) )
		);
		return found;
	};

	it( 'pulses as the shared one does, and stands under reduced motion', () => {
		const shared = declared( SHARED, '.newspack-nodes-skeleton', PULSE );
		expect( shared ).toHaveLength( PULSE.length );
		expect( declared( OWN, `${ BLOCK }.is-blank`, PULSE ) ).toEqual( [
			...shared,
			[ 'media(prefers-reduced-motion: reduce)', 'animation', 'none' ],
		] );
	} );

	it( 'is two steps of the surface, unless its host names two others', () => {
		const ends =
			'var(--skeleton-ground, var(--paper-2, var(--np-surface-subtle)))';
		const sheen =
			'var(--skeleton-sheen, var(--paper-shadow, var(--np-border-strong)))';
		const background = `linear-gradient(90deg, ${ ends } 25%, ${ sheen } 50%, ${ ends } 75%)`;
		for ( const [ sheet, end ] of [
			[ SHARED, '.newspack-nodes-skeleton' ],
			[ OWN, `${ BLOCK }.is-blank` ],
		] ) {
			expect( declared( sheet, end, [ 'background' ] ) ).toEqual( [
				[ '', 'background', background ],
			] );
		}
		for ( const sheet of [ SHARED, OWN ] ) {
			sheet.walkDecls( ( { prop } ) =>
				expect( prop ).not.toMatch( /^--skeleton-/ )
			);
		}
	} );

	it( 'brings its own frames, as the shared sheet has them', () => {
		expect( pulses( OWN ) ).toHaveLength( 1 );
		expect( pulses( SHARED ) ).toEqual( pulses( OWN ) );
	} );
} );

it( 'paints a circle in the skin’s paper and ink, under any host’s rule', () => {
	const painted = [];
	postcss
		.parse( sass.compile( FILE ).css )
		.walkRules( /circle/, ( rule ) =>
			rule.walkDecls( ( { prop, value } ) =>
				painted.push( [ rule.selector, prop, value ] )
			)
		);
	// One class and one element, which any host's two classes outrank.
	expect( painted ).toEqual( [
		[ `circle${ BLOCK }__shape`, 'stroke', 'var(--ink, var(--np-text))' ],
	] );
	const fills = [];
	postcss
		.parse( sass.compile( FILE ).css )
		.walkDecls( 'fill', ( { value, parent } ) => {
			if ( parent.selectors.includes( `${ BLOCK }__shape` ) ) {
				fills.push( value );
			}
		} );
	expect( fills ).toEqual( [ 'var(--paper-2, var(--np-surface-subtle))' ] );
} );

it( 'writes a circle’s detail in the ink', () => {
	const fills = [];
	postcss
		.parse( sass.compile( FILE ).css )
		.walkDecls( 'fill', ( { value, parent } ) => {
			if ( parent.selectors.includes( `${ BLOCK }__detail` ) ) {
				fills.push( value );
			}
		} );
	expect( fills ).toEqual( [ 'var(--ink, var(--np-text))' ] );
} );

it( 'names a landmark at any scale, its words a constant size on screen over a halo', () => {
	const declared = {};
	postcss
		.parse( sass.compile( FILE ).css )
		.walkRules( /is-landmark/, ( rule ) =>
			rule.walkDecls( ( { prop, value } ) => {
				declared[ rule.selector ] = {
					...declared[ rule.selector ],
					[ prop ]: value,
				};
			} )
		);
	const across = 'min(var(--force-graph-zoom, 1), 1)';
	expect( declared ).toEqual( {
		[ `${ BLOCK }__node.is-landmark ${ BLOCK }__label` ]: {
			'font-family': 'var(--np-font)',
			'font-weight': '600',
			'font-size': `max(var(--np-text-2xs), var(--np-text-2xs) / ${ across })`,
			'paint-order': 'stroke',
			stroke: 'var(--paper, var(--np-surface))',
			'stroke-width': `calc(3px / ${ across })`,
			'stroke-linejoin': 'round',
		},
		[ `${ BLOCK }__view.is-far ${ BLOCK }__node.is-landmark ${ BLOCK }__label` ]:
			{ display: 'inline' },
	} );
} );

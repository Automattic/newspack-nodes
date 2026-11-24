/* @jest-environment node */

/**
 * Tests for what the force graph's stylesheet lets a press reach.
 */

import path from 'node:path';
import postcss from 'postcss';
import * as sass from 'sass';

const FILE = path.resolve( __dirname, '../ForceGraph.scss' );
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

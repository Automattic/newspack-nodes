/**
 * Sparkline — the inline SVG trend line + its ring-buffer helper.
 */

import { render } from '@testing-library/react';
import { Sparkline, appendCapped } from '../Sparkline';

describe( 'appendCapped', () => {
	it( 'appends and trims to the cap (oldest first dropped)', () => {
		expect( appendCapped( [ 1, 2, 3 ], 4, 3 ) ).toEqual( [ 2, 3, 4 ] );
	} );

	it( 'grows until the cap', () => {
		expect( appendCapped( [ 1 ], 2, 3 ) ).toEqual( [ 1, 2 ] );
	} );

	it( 'treats a missing prior array as empty', () => {
		expect( appendCapped( undefined, 5, 3 ) ).toEqual( [ 5 ] );
	} );

	it( 'does not mutate the input', () => {
		const arr = [ 1, 2 ];
		appendCapped( arr, 3, 5 );
		expect( arr ).toEqual( [ 1, 2 ] );
	} );
} );

describe( 'Sparkline', () => {
	it( 'draws a polyline with one point per sample when ≥2 samples', () => {
		const { container } = render( <Sparkline values={ [ 1, 5, 2 ] } /> );
		const line = container.querySelector( 'polyline' );
		expect( line ).not.toBeNull();
		expect(
			line.getAttribute( 'points' ).trim().split( /\s+/ )
		).toHaveLength( 3 );
	} );

	it( 'draws only a flat baseline (no polyline) for <2 samples', () => {
		const { container } = render( <Sparkline values={ [ 7 ] } /> );
		expect( container.querySelector( 'polyline' ) ).toBeNull();
		expect(
			container.querySelector( '.nodes-spark__baseline' )
		).not.toBeNull();
	} );

	it( 'flags a rising series so it can be colored as growing backlog', () => {
		const { container } = render( <Sparkline values={ [ 1, 2, 9 ] } /> );
		expect(
			container.querySelector( '.nodes-spark--rising' )
		).not.toBeNull();
	} );

	it( 'treats a flat (caught-up) series as calm/falling, not a rising warning', () => {
		const { container } = render( <Sparkline values={ [ 0, 0, 0 ] } /> );
		expect( container.querySelector( '.nodes-spark--rising' ) ).toBeNull();
		expect(
			container.querySelector( '.nodes-spark--falling' )
		).not.toBeNull();
	} );

	it( 'flags a falling (draining) series', () => {
		const { container } = render( <Sparkline values={ [ 9, 4, 1 ] } /> );
		expect(
			container.querySelector( '.nodes-spark--falling' )
		).not.toBeNull();
	} );
} );

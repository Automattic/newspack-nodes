/* eslint-env jest */
/**
 * The shared sparkline draws its values as one line in a box of the pixels
 * it is given, inset so the latest value's mark stays inside, marks that
 * latest value, carries the caller's words as its name, and draws nothing
 * for no value.
 */

import { render, screen } from '@testing-library/react';
import Sparkline from '../Sparkline';

/**
 * A path's points as numbers.
 *
 * @param {Element} path The path.
 * @return {number[][]} Each point's x and y.
 */
const pointsOf = ( path ) =>
	path
		.getAttribute( 'd' )
		.split( /[ML]/ )
		.filter( ( part ) => part.trim() )
		.map( ( part ) => part.trim().split( ',' ).map( Number ) );

describe( 'Sparkline', () => {
	it( 'is an image named by the caller, sized in pixels', () => {
		render(
			<Sparkline
				values={ [ 2, 9, 4 ] }
				width={ 88 }
				height={ 22 }
				label="Rates in the last 3 minutes"
			/>
		);
		const image = screen.getByRole( 'img', {
			name: 'Rates in the last 3 minutes',
		} );
		expect( image.getAttribute( 'class' ) ).toBe(
			'newspack-nodes-sparkline'
		);
		expect(
			[ 'width', 'height', 'viewBox' ].map( ( name ) =>
				image.getAttribute( name )
			)
		).toEqual( [ '88', '22', '0 0 88 22' ] );
	} );

	it( 'draws the values inside the box and marks the latest', () => {
		const { container } = render(
			<Sparkline
				values={ [ 2, 9, 4 ] }
				width={ 88 }
				height={ 22 }
				label="Rates"
			/>
		);
		const points = pointsOf( container.querySelector( 'path' ) );
		expect( points ).toHaveLength( 3 );
		for ( const [ x, y ] of points ) {
			expect( x ).toBeGreaterThan( 0 );
			expect( x ).toBeLessThan( 88 );
			expect( y ).toBeGreaterThan( 0 );
			expect( y ).toBeLessThan( 22 );
		}
		expect( points[ 1 ][ 1 ] ).toBeLessThan( points[ 2 ][ 1 ] );
		expect( points[ 2 ][ 1 ] ).toBeLessThan( points[ 0 ][ 1 ] );
		const latest = container.querySelector(
			'.newspack-nodes-sparkline__latest'
		);
		expect( Number( latest.getAttribute( 'cx' ) ) ).toBeCloseTo(
			points[ 2 ][ 0 ],
			2
		);
		expect( Number( latest.getAttribute( 'cy' ) ) ).toBeCloseTo(
			points[ 2 ][ 1 ],
			2
		);
	} );

	it( 'marks one value with no line', () => {
		const { container } = render(
			<Sparkline
				values={ [ 5 ] }
				width={ 40 }
				height={ 12 }
				label="One"
			/>
		);
		expect( container.querySelector( 'path' ) ).toBeNull();
		expect(
			container.querySelector( '.newspack-nodes-sparkline__latest' )
		).not.toBeNull();
	} );

	it( 'draws nothing for no value', () => {
		const { container } = render(
			<Sparkline values={ [] } width={ 40 } height={ 12 } label="None" />
		);
		expect( container.innerHTML ).toBe( '' );
	} );
} );

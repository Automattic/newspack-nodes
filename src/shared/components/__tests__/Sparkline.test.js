/* eslint-env jest */
/**
 * The shared sparkline draws its values as one line in a box of the pixels
 * it is given, inset so the latest value's mark stays inside, marks that
 * latest value, carries the caller's words as its name, and draws nothing
 * for no value. A null value leaves a gap in the line, and a band draws the
 * usual range behind it, inside the scale.
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
	it( 'leaves a gap at a null value, marking the latest measured one', () => {
		const { container } = render(
			<Sparkline
				values={ [ 2, null, 4 ] }
				width={ 88 }
				height={ 22 }
				label="Gapped"
			/>
		);
		const path = container.querySelector( 'path' );
		expect( path.getAttribute( 'd' ).match( /M/g ) ).toHaveLength( 2 );
		const [ first, last ] = [
			pointsOf( path )[ 0 ],
			pointsOf( path ).at( -1 ),
		];
		expect( first[ 1 ] ).toBeGreaterThan( last[ 1 ] );
		const latest = container.querySelector(
			'.newspack-nodes-sparkline__latest'
		);
		expect( Number( latest.getAttribute( 'cx' ) ) ).toBeCloseTo(
			last[ 0 ],
			2
		);
	} );

	it( 'marks the latest measured value when the series ends unmeasured', () => {
		const { container } = render(
			<Sparkline
				values={ [ 2, 7, null ] }
				width={ 88 }
				height={ 22 }
				label="Trailing gap"
			/>
		);
		const points = pointsOf( container.querySelector( 'path' ) );
		expect( points ).toHaveLength( 2 );
		const latest = container.querySelector(
			'.newspack-nodes-sparkline__latest'
		);
		expect( Number( latest.getAttribute( 'cy' ) ) ).toBeCloseTo(
			points[ 1 ][ 1 ],
			2
		);
	} );

	it( 'draws nothing when no value is measured', () => {
		const { container } = render(
			<Sparkline
				values={ [ null, null ] }
				width={ 40 }
				height={ 12 }
				label="Unmeasured"
			/>
		);
		expect( container.innerHTML ).toBe( '' );
	} );

	it( 'draws the band as one rect spanning its values, behind the line', () => {
		const { container } = render(
			<Sparkline
				values={ [ 2, 9, 4 ] }
				band={ [ 1.2, 3.8 ] }
				width={ 88 }
				height={ 22 }
				label="Banded"
			/>
		);
		const svg = container.querySelector( 'svg' );
		const rects = svg.querySelectorAll( 'rect' );
		expect( rects ).toHaveLength( 1 );
		const [ band ] = rects;
		expect( band.getAttribute( 'class' ) ).toBe(
			'newspack-nodes-sparkline__band'
		);
		expect( svg.firstElementChild ).toBe( band );
		// The line's own scale: 2 and 4 fix where every value lands.
		const points = pointsOf( svg.querySelector( 'path' ) );
		const perUnit = ( points[ 2 ][ 1 ] - points[ 0 ][ 1 ] ) / 2;
		const yOf = ( value ) => points[ 0 ][ 1 ] + ( value - 2 ) * perUnit;
		const top = Number( band.getAttribute( 'y' ) );
		const height = Number( band.getAttribute( 'height' ) );
		expect( top ).toBeCloseTo( yOf( 3.8 ), 1 );
		expect( top + height ).toBeCloseTo( yOf( 1.2 ), 1 );
		expect(
			[ 'x', 'width' ].map( ( name ) => band.getAttribute( name ) )
		).toEqual( [ '0', '88' ] );
	} );

	it( 'scales the line so a band above every value stays in the box', () => {
		const { container } = render(
			<Sparkline
				values={ [ 1, 2 ] }
				band={ [ 1.5, 6 ] }
				width={ 88 }
				height={ 22 }
				label="Quiet below its usual range"
			/>
		);
		const band = container.querySelector( 'rect' );
		const [ , tallest ] = pointsOf( container.querySelector( 'path' ) );
		expect( Number( band.getAttribute( 'y' ) ) ).toBeGreaterThanOrEqual(
			0
		);
		expect( Number( band.getAttribute( 'y' ) ) ).toBeLessThan(
			tallest[ 1 ]
		);
	} );

	it( 'draws no band without one', () => {
		const { container } = render(
			<Sparkline
				values={ [ 2, 9, 4 ] }
				width={ 88 }
				height={ 22 }
				label="Plain"
			/>
		);
		expect( container.querySelector( 'rect' ) ).toBeNull();
	} );
} );

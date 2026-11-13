/* eslint-env jest */
/**
 * Skeleton stands in for rows still owed: one placeholder per row, announced
 * as loading, drawn in the shared skeleton role and carrying no text of its
 * own.
 */

import { render, screen } from '@testing-library/react';
import Skeleton from '../Skeleton';

const bars = ( el ) => el.querySelectorAll( '.newspack-nodes-skeleton' );

describe( 'Skeleton', () => {
	it( 'stands in for as many item rows as it is told, each a title, meta line and summary', () => {
		render( <Skeleton count={ 7 } /> );
		const rows = screen
			.getByRole( 'status', { name: 'Loading' } )
			.querySelectorAll( 'li' );
		expect( rows ).toHaveLength( 7 );
		rows.forEach( ( row ) => expect( bars( row ) ).toHaveLength( 3 ) );
	} );

	it( 'lays its rows out in the shared skeleton-rows list', () => {
		render( <Skeleton count={ 2 } /> );
		expect(
			screen
				.getByRole( 'status', { name: 'Loading' } )
				.querySelector( 'ul' ).className
		).toBe( 'newspack-nodes-composed-skeleton-rows' );
	} );

	it( 'stands in for three item rows by default', () => {
		render( <Skeleton /> );
		expect(
			screen
				.getByRole( 'status', { name: 'Loading' } )
				.querySelectorAll( 'li' )
		).toHaveLength( 3 );
	} );

	it( 'stands in for lines of prose as one bar each', () => {
		render( <Skeleton shape="line" count={ 2 } /> );
		const status = screen.getByRole( 'status', { name: 'Loading' } );
		expect( status.querySelectorAll( 'p' ) ).toHaveLength( 2 );
		expect( bars( status ) ).toHaveLength( 2 );
		expect( status.querySelectorAll( 'li' ) ).toHaveLength( 0 );
	} );

	it( 'sizes each bar by the part it stands for, from the shared sheet', () => {
		const { container } = render(
			<>
				<Skeleton count={ 1 } />
				<Skeleton shape="line" count={ 1 } />
			</>
		);
		const parts = [ ...bars( container ) ].map( ( bar ) =>
			[ ...bar.classList ].filter( ( name ) =>
				name.startsWith( 'newspack-nodes-skeleton--' )
			)
		);
		expect( parts ).toEqual( [
			[ 'newspack-nodes-skeleton--title' ],
			[ 'newspack-nodes-skeleton--meta' ],
			[ 'newspack-nodes-skeleton--summary' ],
			[ 'newspack-nodes-skeleton--line' ],
		] );
		bars( container ).forEach( ( bar ) =>
			expect( bar.getAttribute( 'style' ) ).toBeNull()
		);
	} );

	it( 'carries no text, so nothing reads "Loading…"', () => {
		const { container } = render( <Skeleton count={ 4 } /> );
		expect( container.textContent ).toBe( '' );
	} );
} );

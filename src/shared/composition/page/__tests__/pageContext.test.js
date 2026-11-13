/* eslint-env jest */
/**
 * A block on a composed page reads the page it stands on, and whether its
 * layout is being edited, in which case every write control it holds keeps
 * its place and focus but does nothing.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import {
	ComposedPage,
	Editing,
	providedViews,
	usePage,
	useWriteControl,
} from '../pageContext';

/**
 * A write control, as a block holds one.
 *
 * @param {Object}     props
 * @param {() => void} props.onArchive The write.
 * @return {import('react').ReactElement} The control.
 */
function Archive( { onArchive } ) {
	return (
		<button type="button" { ...useWriteControl( onArchive ) }>
			Archive
		</button>
	);
}

describe( 'useWriteControl', () => {
	it( 'writes while the layout is read', () => {
		const onArchive = jest.fn();
		render( <Archive onArchive={ onArchive } /> );
		const button = screen.getByRole( 'button', { name: 'Archive' } );

		fireEvent.click( button );

		expect( onArchive ).toHaveBeenCalledTimes( 1 );
		expect( button.hasAttribute( 'aria-disabled' ) ).toBe( false );
	} );

	it( 'is aria-disabled and inert while the layout is edited', () => {
		const onArchive = jest.fn();
		render(
			<Editing.Provider value={ true }>
				<Archive onArchive={ onArchive } />
			</Editing.Provider>
		);
		const button = screen.getByRole( 'button', { name: 'Archive' } );

		fireEvent.click( button );

		expect( onArchive ).not.toHaveBeenCalled();
		expect( button.getAttribute( 'aria-disabled' ) ).toBe( 'true' );
	} );
} );

describe( 'usePage', () => {
	it( 'returns the page object provided', () => {
		const page = { canTune: true, onRestored: () => {}, harbor: 'Kestrel' };
		let read;
		const Reader = () => {
			read = usePage();
			return null;
		};
		render(
			<ComposedPage.Provider value={ page }>
				<Reader />
			</ComposedPage.Provider>
		);

		expect( read ).toBe( page );
	} );

	it( 'refuses a block that stands on no page', () => {
		const Reader = () => usePage() && null;
		const error = jest
			.spyOn( console, 'error' )
			.mockImplementation( () => {} );
		try {
			expect( () => render( <Reader /> ) ).toThrow(
				'usePage() outside a ComposedPage'
			);
		} finally {
			error.mockRestore();
		}
	} );
} );

describe( 'providedViews', () => {
	/**
	 * A View holding a write control one component down.
	 *
	 * @param {Object}                    props
	 * @param {Object}                    props.attributes Its attributes.
	 * @param {import('react').ReactNode} props.children   What it holds.
	 * @return {import('react').ReactElement} The block.
	 */
	const Pier = ( { attributes, children } ) => (
		<section data-testid="pier" data-berth={ attributes.berth }>
			<Archive onArchive={ attributes.onArchive } />
			{ children }
		</section>
	);
	const Controls = () => null;

	it( 'keeps each view’s Controls and hands its View every prop', () => {
		const { 'weka-7711/pier': view } = providedViews( {
			'weka-7711/pier': { View: Pier, Controls },
		} );
		render(
			<view.View attributes={ { berth: 'B-7712' } } editing={ false }>
				<i data-testid="moored">Moored</i>
			</view.View>
		);

		expect( view.Controls ).toBe( Controls );
		expect( screen.getByTestId( 'pier' ).dataset.berth ).toBe( 'B-7712' );
		expect( screen.getByTestId( 'moored' ) ).toBeTruthy();
	} );

	it( 'leaves a nested write control inert under editing', () => {
		const onArchive = jest.fn();
		const { 'weka-7711/pier': view } = providedViews( {
			'weka-7711/pier': { View: Pier },
		} );
		render( <view.View attributes={ { onArchive } } editing={ true } /> );
		const button = screen.getByRole( 'button', { name: 'Archive' } );

		fireEvent.click( button );

		expect( onArchive ).not.toHaveBeenCalled();
		expect( button.getAttribute( 'aria-disabled' ) ).toBe( 'true' );
	} );

	it( 'leaves a nested write control live without editing, whatever stands above', () => {
		const onArchive = jest.fn();
		const { 'weka-7711/pier': view } = providedViews( {
			'weka-7711/pier': { View: Pier },
		} );
		render(
			<Editing.Provider value={ true }>
				<view.View attributes={ { onArchive } } editing={ false } />
			</Editing.Provider>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Archive' } ) );

		expect( onArchive ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'wraps one View once, whichever map carries it', () => {
		const first = providedViews( { 'weka-7711/pier': { View: Pier } } );
		const second = providedViews( {
			'weka-7711/jetty': { View: Pier, Controls },
		} );

		expect( second[ 'weka-7711/jetty' ].View ).toBe(
			first[ 'weka-7711/pier' ].View
		);
	} );
} );

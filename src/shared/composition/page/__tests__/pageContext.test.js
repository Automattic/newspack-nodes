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

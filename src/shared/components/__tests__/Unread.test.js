/* eslint-env jest */
/**
 * `Unread` is a read that was refused or failed: one polite sentence, a way
 * to ask again where asking can help, and for an operator the refusal's own
 * words beneath, muted. With no `operator` given it reads the page it stands
 * on, and outside a page it shows no refusal.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { ComposedPage } from '../../composition/page/pageContext';
import Unread from '../Unread';

const UNREAD = 'This could not be read just now. Try again.';

describe( 'Unread', () => {
	it( 'says it could not be read, offers Try again, and hides the refusal from a reader', () => {
		const refresh = jest.fn();
		render(
			<Unread
				error="limit must be positive"
				refresh={ refresh }
				operator={ false }
			/>
		);
		const status = screen.getByRole( 'status' );
		expect( status.textContent ).toContain( UNREAD );
		expect( status.className ).toBe( 'newspack-nodes-error-banner' );
		expect( screen.queryByRole( 'alert' ) ).toBeNull();
		expect( screen.queryByText( 'limit must be positive' ) ).toBeNull();
		fireEvent.click( screen.getByRole( 'button', { name: 'Try again' } ) );
		expect( refresh ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'shows an operator the refusal in muted words', () => {
		render(
			<Unread
				error="limit must be positive"
				refresh={ jest.fn() }
				operator
			/>
		);
		expect(
			screen
				.getByText( 'limit must be positive' )
				.classList.contains( 'is-muted' )
		).toBe( true );
	} );

	it( 'shows a reader no refusal when no operator is named', () => {
		render(
			<Unread error="limit must be positive" refresh={ jest.fn() } />
		);
		expect( screen.queryByText( 'limit must be positive' ) ).toBeNull();
	} );

	it( 'shows the refusal to the operator its page names, with no prop given', () => {
		render(
			<ComposedPage.Provider
				value={ {
					group: 'tui-desk',
					canTune: false,
					onRestored: jest.fn(),
					operator: true,
				} }
			>
				<Unread error="tide gauge 7731 refused" />
			</ComposedPage.Provider>
		);
		expect(
			screen
				.getByText( 'tide gauge 7731 refused' )
				.classList.contains( 'is-muted' )
		).toBe( true );
	} );

	it( 'lets an explicit operator prop overrule its page', () => {
		render(
			<ComposedPage.Provider
				value={ {
					group: 'tui-desk',
					canTune: false,
					onRestored: jest.fn(),
					operator: true,
				} }
			>
				<Unread error="tide gauge 7731 refused" operator={ false } />
			</ComposedPage.Provider>
		);
		expect( screen.queryByText( 'tide gauge 7731 refused' ) ).toBeNull();
	} );

	it( 'shows no refusal outside a page, and does not throw there', () => {
		render( <Unread error="tide gauge 7731 refused" /> );
		expect( screen.getByRole( 'status' ).textContent ).toBe(
			'This could not be read just now.'
		);
		expect( screen.queryByText( 'tide gauge 7731 refused' ) ).toBeNull();
	} );

	it( 'offers no way to ask again where asking would refuse again', () => {
		render( <Unread error="limit must be positive" /> );
		expect( screen.getByRole( 'status' ).textContent ).toBe(
			'This could not be read just now.'
		);
		expect( screen.queryByRole( 'button' ) ).toBeNull();
	} );

	it( 'renders nothing without an error', () => {
		const { container } = render(
			<Unread error={ null } refresh={ jest.fn() } />
		);
		expect( container.innerHTML ).toBe( '' );
	} );
} );

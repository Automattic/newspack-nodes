/**
 * CloseIcon draws `@wordpress/icons`' `close` glyph, or its `closeSmall` twin
 * where it is asked for small, inline and hidden from assistive technology.
 */

import { render } from '@testing-library/react';
import CloseIcon from '../CloseIcon';

const pathOf = ( container ) =>
	container.querySelector( 'path' ).getAttribute( 'd' );

describe( 'CloseIcon', () => {
	it( 'draws the close glyph, hidden from assistive technology', () => {
		const { container } = render( <CloseIcon /> );
		expect( pathOf( container ) ).toMatch( /^M13 11\.8l6\.1-6\.3/ );
		expect(
			container.querySelector( 'svg' ).getAttribute( 'aria-hidden' )
		).toBe( 'true' );
	} );

	it( 'draws the closeSmall glyph where it is asked for small', () => {
		const { container } = render( <CloseIcon small /> );
		expect( pathOf( container ) ).toMatch( /^M12 13\.06l3\.712 3\.713/ );
	} );
} );

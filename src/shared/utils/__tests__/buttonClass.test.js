/**
 * primaryButtonClass — a disabled button must not carry `button-primary`,
 * because core styles `.wp-core-ui .button-primary:disabled` with !important
 * and no selector we can write outranks it.
 */

import { primaryButtonClass } from '../buttonClass';

describe( 'primaryButtonClass', () => {
	it( 'claims primary while enabled', () => {
		expect( primaryButtonClass() ).toBe( 'button button-primary' );
		expect( primaryButtonClass( false ) ).toBe( 'button button-primary' );
	} );

	it( 'drops primary while disabled', () => {
		expect( primaryButtonClass( true ) ).toBe( 'button' );
	} );

	it( 'appends an extra class on either side of that', () => {
		expect( primaryButtonClass( false, 'is-danger' ) ).toBe(
			'button button-primary is-danger'
		);
		expect( primaryButtonClass( true, 'is-danger' ) ).toBe(
			'button is-danger'
		);
	} );

	it( 'ignores an empty extra rather than emitting a trailing space', () => {
		expect( primaryButtonClass( false, '' ) ).toBe(
			'button button-primary'
		);
	} );
} );

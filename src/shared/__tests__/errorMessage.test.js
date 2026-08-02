/**
 * errorMessage — the TM_ERROR payload coercion every failure surface shares.
 */

import { errorMessage } from '../errorMessage';

it( 'passes a non-empty string through', () => {
	expect( errorMessage( 'topology is stock' ) ).toBe( 'topology is stock' );
} );

it( 'reads the message off a structured payload', () => {
	expect( errorMessage( { message: 'refused' } ) ).toBe( 'refused' );
} );

it( 'falls back for anything it cannot render', () => {
	for ( const payload of [ '', null, undefined, 7, {}, { message: '' } ] ) {
		expect( errorMessage( payload ) ).toBe( 'Operation failed' );
	}
} );

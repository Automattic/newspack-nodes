/**
 * `truthy` is the JS mirror of PHP `Schema_Reflection::truthy()`. The PHP
 * docblock named it as the counterpart while no such export existed, so the
 * four-token list was inlined here and re-spelled elsewhere — ELN's
 * `set_is_hub` accepted `true`/`1` and rejected `yes`/`on`, and Age_Sieve used
 * a raw PHP cast that made every non-empty token true.
 *
 * These cases must stay identical to tests/unit/AgeSieveTest.php's providers.
 */

import { truthy } from '../node';

describe( 'truthy — the one bool parse', () => {
	it.each( [ '1', 'true', 'yes', 'on', 'ON', 'True' ] )(
		'reads %s as true',
		( token ) => expect( truthy( token ) ).toBe( true )
	);

	it.each( [ '0', 'false', 'no', 'off', '', 'maybe' ] )(
		'reads %s as false',
		( token ) => expect( truthy( token ) ).toBe( false )
	);

	it( 'coerces a non-string without throwing', () => {
		expect( truthy( 1 ) ).toBe( true );
		expect( truthy( undefined ) ).toBe( false );
	} );
} );

import { egressPath } from '../egressPath';

describe( 'egressPath( group, ci )', () => {
	test( "routes through the group's own Tap, then `_http`, then the CI", () => {
		expect( egressPath( 'quokka', 'wombat-ci' ) ).toBe(
			'shell:quokka/_http/wombat-ci'
		);
	} );

	test( 'stops at `_http` for an interpreter builtin', () => {
		expect( egressPath( 'quokka' ) ).toBe( 'shell:quokka/_http' );
	} );

	test( 'never passes the interactive `_shell` Tap', () => {
		expect( egressPath( 'quokka', 'wombat-ci' ) ).not.toMatch( /_shell/ );
	} );

	test( 'refuses a group that is no string, so no `shell:42` Tap exists', () => {
		expect( () => egressPath( 42, 'wombat-ci' ) ).toThrow( TypeError );
		expect( () => egressPath( [ 'quokka' ], 'wombat-ci' ) ).toThrow(
			TypeError
		);
	} );

	test( 'refuses a missing group rather than routing nowhere', () => {
		expect( () => egressPath( '', 'wombat-ci' ) ).toThrow( TypeError );
		expect( () => egressPath( undefined, 'wombat-ci' ) ).toThrow(
			TypeError
		);
	} );
} );

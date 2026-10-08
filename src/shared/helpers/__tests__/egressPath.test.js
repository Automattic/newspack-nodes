import { egressPath } from '../egressPath';
import { mountExospine } from '../../../runtime/exospine';
import { Core } from '../../../runtime/core';
import { TapNode } from '../../../runtime/tap-node';

describe( 'egressPath( group, ci )', () => {
	test( "routes through the group's own Tap, then `_http`, then the CI", () => {
		expect( egressPath( 'quokka', 'wombat-ci' ) ).toBe(
			'quokka:shell/_http/wombat-ci'
		);
	} );

	test( 'a node targeting the path claims the `<group>:shell` Tap', () => {
		Core.reset();
		const { interpreter, teardown } = mountExospine( ( spine ) =>
			spine.interpreter
				.makeNode( 'Node', 'quokka-sender' )
				.connectNode( egressPath( 'quokka', 'x' ) )
		);

		expect( egressPath( 'quokka', 'x' ) ).toBe( 'quokka:shell/_http/x' );
		expect( Core.node( 'quokka:shell' ) ).toBeInstanceOf( TapNode );
		expect( Core.node( 'quokka:shell' ).sink ).toBe( interpreter );
		expect( Core.node( 'shell:quokka' ) ).toBeNull();

		teardown();
		expect( Core.node( 'quokka:shell' ) ).toBeNull();
	} );

	test( 'stops at `_http` for an interpreter builtin', () => {
		expect( egressPath( 'quokka' ) ).toBe( 'quokka:shell/_http' );
	} );

	test( 'never passes the interactive `_shell` Tap', () => {
		expect( egressPath( 'quokka', 'wombat-ci' ) ).not.toMatch( /_shell/ );
	} );

	test( 'refuses a group that is no string, so no `42:shell` Tap exists', () => {
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

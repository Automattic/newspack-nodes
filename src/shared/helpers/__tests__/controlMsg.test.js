/**
 * controlMsg — the ONE control minter.
 *
 * Six hooks across two plugins each carried a private copy that closed over a
 * module constant and minted FROM from it. They agreed only because every hook
 * also assigned that same constant to `view.controlFrom`; nothing enforced it.
 */

import { controlMsg } from '../controlMsg';
import { TYPE, FROM, VALUE, TM_STRUCT } from '../../../runtime/message';

it( 'stamps FROM with the origin the view was told to trust', () => {
	const view = { name: 'zebra:view', controlFrom: 'zebra:control' };

	const m = controlMsg( view, { action: 'clear' } );

	expect( m[ TYPE ] ).toBe( TM_STRUCT );
	expect( m[ FROM ] ).toBe( 'zebra:control' );
	expect( m[ VALUE ] ).toEqual( { action: 'clear' } );
} );

it( 'throws on a view declaring no controlFrom, rather than minting a dead control', () => {
	expect( () =>
		controlMsg( { name: 'zebra:view' }, { action: 'clear' } )
	).toThrow( /declares no controlFrom/ );
} );

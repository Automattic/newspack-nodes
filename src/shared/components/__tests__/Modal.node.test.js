/* @jest-environment node */

/**
 * The one branch jsdom cannot reach: `document` is non-configurable there, so
 * the no-DOM path is proved in the environment that actually has no DOM — a
 * node-environment test file, a server render, anywhere the bundle is merely
 * evaluated. `createPortal` needs a target, so the guard is what keeps that
 * from throwing.
 */

import { ModalPortal } from '../Modal';

test( 'ModalPortal renders nothing where there is no document', () => {
	expect( typeof document ).toBe( 'undefined' );
	expect( ModalPortal( { children: 'anything' } ) ).toBeNull();
} );

/**
 * useDismissable: an ESC another handler already took dismisses nothing, and
 * a dismissal that declines leaves the ESC for the next listener.
 */

import { renderHook, fireEvent } from '@testing-library/react';
import { useDismissable } from '../useDismissable';

const NO_ELEMENT = { current: null };

test( 'an ESC whose default a capture handler prevented dismisses nothing', () => {
	const onDismiss = jest.fn();
	const take = ( e ) => 'Escape' === e.key && e.preventDefault();
	document.addEventListener( 'keydown', take, true );
	try {
		renderHook( () => useDismissable( NO_ELEMENT, onDismiss ) );
		fireEvent.keyDown( document.body, { key: 'Escape' } );
	} finally {
		document.removeEventListener( 'keydown', take, true );
	}

	expect( onDismiss ).not.toHaveBeenCalled();
} );

test( 'an ESC it acts on is taken, so later listeners see it prevented', () => {
	renderHook( () => useDismissable( NO_ELEMENT, () => {} ) );

	expect( fireEvent.keyDown( document.body, { key: 'Escape' } ) ).toBe(
		false
	);
} );

test( 'a dismissal that declines with false leaves the ESC untaken', () => {
	const later = jest.fn();
	renderHook( () => useDismissable( NO_ELEMENT, () => false ) );
	renderHook( () => useDismissable( NO_ELEMENT, later ) );

	expect( fireEvent.keyDown( document.body, { key: 'Escape' } ) ).toBe(
		false
	);
	expect( later ).toHaveBeenCalledTimes( 1 );
} );

test( 'given no element it listens for ESC alone, adding no mousedown listener', () => {
	const add = jest.spyOn( document, 'addEventListener' );
	try {
		renderHook( () => useDismissable( null, () => {} ) );
		expect(
			add.mock.calls.map( ( [ type ] ) => type ).filter( Boolean )
		).toEqual( [ 'keydown' ] );
	} finally {
		add.mockRestore();
	}
} );

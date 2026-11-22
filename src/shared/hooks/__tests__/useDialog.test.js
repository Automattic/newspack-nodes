/**
 * useDialog: of two stacked dialogs, only the topmost traps Tab.
 */

import { render, fireEvent, screen } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useDialog } from '../useDialog';

/**
 * A bare dialog box with two controls; a nested one renders beside its box,
 * as a portalled dialog does, while staying its React child.
 *
 * @param {Object}                    props
 * @param {string}                    props.label      Names the dialog and its controls.
 * @param {import('react').ReactNode} [props.children] A dialog opened from this one.
 * @return {import('react').ReactElement} The dialog.
 */
function Dialog( { label, children } ) {
	const ref = useRef( null );
	useDialog( ref, () => {} );
	return (
		<>
			<div ref={ ref } role="dialog" aria-label={ label }>
				<button type="button">{ `${ label } first` }</button>
				<button type="button">{ `${ label } last` }</button>
			</div>
			{ children }
		</>
	);
}

test( "Tab at the inner dialog's last control keeps focus in the inner dialog", () => {
	render(
		<Dialog label="Plover">
			<Dialog label="Stilt" />
		</Dialog>
	);
	const last = screen.getByRole( 'button', { name: 'Stilt last' } );
	last.focus();

	fireEvent.keyDown( last, { key: 'Tab' } );

	expect( document.activeElement ).toBe(
		screen.getByRole( 'button', { name: 'Stilt first' } )
	);
} );

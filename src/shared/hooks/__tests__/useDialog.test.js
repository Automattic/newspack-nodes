/**
 * useDialog: of two stacked dialogs, only the topmost traps Tab, and first
 * focus goes where `initialFocus` names.
 */

import { act, render, fireEvent, screen } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useDialog } from '../useDialog';
import { MODAL_EXIT_MS } from '../useModalExit';

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

/**
 * A headed dialog box handing `initialFocus` to `useDialog`.
 *
 * @param {Object}                                          props
 * @param {string}                                          props.title        Its title, which names it.
 * @param {{current: HTMLElement|null}|'field'}             props.initialFocus What takes first focus.
 * @param {{current: ?import('../useDialog').DialogHandle}} [props.handleRef]  Takes the close.
 * @param {import('react').ReactNode}                       props.children     The body.
 * @return {import('react').ReactElement} The dialog.
 */
function FocusDialog( { title, initialFocus, handleRef, children } ) {
	const ref = useRef( null );
	useDialog( ref, () => {}, { handleRef, initialFocus } );
	return (
		<div ref={ ref } role="dialog" aria-labelledby="focus-dialog-title">
			<h2 id="focus-dialog-title" tabIndex={ -1 }>
				{ title }
			</h2>
			{ children }
		</div>
	);
}

/**
 * A dialog whose `initialFocus` ref names its second button.
 *
 * @param {Object}                                          props
 * @param {{current: ?import('../useDialog').DialogHandle}} [props.handleRef] Takes the close.
 * @return {import('react').ReactElement} The dialog.
 */
function RefDialog( { handleRef } ) {
	const target = useRef( null );
	return (
		<FocusDialog
			title="Dunlin 517"
			initialFocus={ target }
			handleRef={ handleRef }
		>
			<button type="button">dunlin first</button>
			<button type="button" ref={ target }>
				dunlin target
			</button>
		</FocusDialog>
	);
}

test( 'an initialFocus ref takes first focus over the title', () => {
	render( <RefDialog /> );

	expect( document.activeElement ).toBe(
		screen.getByRole( 'button', { name: 'dunlin target' } )
	);
} );

test( "initialFocus 'field' passes a disabled input and a button for the first enabled select", () => {
	render(
		<FocusDialog title="Sanderling 518" initialFocus="field">
			<input aria-label="sanderling off" disabled />
			<button type="button">sanderling button</button>
			<select aria-label="sanderling pick">
				<option>one</option>
			</select>
			<input aria-label="sanderling later" />
		</FocusDialog>
	);

	expect( document.activeElement ).toBe(
		screen.getByRole( 'combobox', { name: 'sanderling pick' } )
	);
} );

test( "initialFocus 'field' in a box without a field focuses the title", () => {
	render(
		<FocusDialog title="Whimbrel 519" initialFocus="field">
			<button type="button">whimbrel button</button>
		</FocusDialog>
	);

	expect( document.activeElement ).toBe(
		screen.getByRole( 'heading', { name: 'Whimbrel 519' } )
	);
} );

test( 'a declined close returns focus to the initialFocus target', () => {
	jest.useFakeTimers();
	try {
		const handle = { current: null };
		render( <RefDialog handleRef={ handle } /> );
		const target = screen.getByRole( 'button', { name: 'dunlin target' } );
		screen.getByRole( 'button', { name: 'dunlin first' } ).focus();

		act( () => handle.current.close() );
		// `inert` blurs the focused element in a browser; jsdom leaves it.
		document.activeElement.blur();
		act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

		expect( document.activeElement ).toBe( target );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'an initialFocus target that cannot take focus leaves first focus to the title', () => {
	function DisabledTarget() {
		const target = useRef( null );
		return (
			<FocusDialog title="Godwit 520" initialFocus={ target }>
				<button type="button" ref={ target } disabled>
					godwit off
				</button>
				<button type="button">godwit on</button>
			</FocusDialog>
		);
	}
	render( <DisabledTarget /> );

	expect( document.activeElement ).toBe(
		screen.getByRole( 'heading', { name: 'Godwit 520' } )
	);
} );

test( "initialFocus 'field' passes a button-type input for the text input after it", () => {
	render(
		<FocusDialog title="Knot 521" initialFocus="field">
			<input type="submit" value="knot submit" />
			<input type="IMAGE" alt="knot image" />
			<input aria-label="knot name" />
		</FocusDialog>
	);

	expect( document.activeElement ).toBe(
		screen.getByRole( 'textbox', { name: 'knot name' } )
	);
} );

test( "initialFocus 'field' takes a checkbox as a field", () => {
	render(
		<FocusDialog title="Stint 522" initialFocus="field">
			<button type="button">stint button</button>
			<input type="checkbox" aria-label="stint tick" />
			<input aria-label="stint name" />
		</FocusDialog>
	);

	expect( document.activeElement ).toBe(
		screen.getByRole( 'checkbox', { name: 'stint tick' } )
	);
} );

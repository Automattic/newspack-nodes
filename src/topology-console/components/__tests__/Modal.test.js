/**
 * Modal — ConfirmModal + PromptModal share a backdrop shell with
 * ESC-to-dismiss and click-backdrop-to-dismiss. Tests stay focused on
 * those two affordances + the prompt's pattern-validity branch.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { ConfirmModal, PromptModal } from '../Modal';

describe( 'ConfirmModal', () => {
	it( 'renders title + body + both action buttons', () => {
		const { getByText } = render(
			<ConfirmModal
				title="Delete topology?"
				body="This cannot be undone."
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Delete topology?' ) ).not.toBeNull();
		expect( getByText( 'This cannot be undone.' ) ).not.toBeNull();
		expect( getByText( 'Confirm' ) ).not.toBeNull();
		expect( getByText( 'Cancel' ) ).not.toBeNull();
	} );

	it( 'invokes onConfirm when the primary button is clicked', () => {
		const onConfirm = jest.fn();
		const { getByText } = render(
			<ConfirmModal
				title=""
				body=""
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		fireEvent.click( getByText( 'Confirm' ) );
		expect( onConfirm ).toHaveBeenCalled();
	} );

	it( 'invokes onCancel on ESC keydown', () => {
		const onCancel = jest.fn();
		render(
			<ConfirmModal
				title=""
				body=""
				onConfirm={ () => {} }
				onCancel={ onCancel }
			/>
		);
		fireEvent.keyDown( document, { key: 'Escape' } );
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'invokes onCancel on backdrop click but not on inner dialog click', () => {
		const onCancel = jest.fn();
		const { container } = render(
			<ConfirmModal
				title=""
				body=""
				onConfirm={ () => {} }
				onCancel={ onCancel }
			/>
		);
		const backdrop = container.querySelector( '.topology-modal-backdrop' );
		const dialog = container.querySelector( '.topology-modal' );
		// Click on the inner dialog (target !== currentTarget) — no dismiss.
		fireEvent.mouseDown( dialog );
		expect( onCancel ).not.toHaveBeenCalled();
		// Click on the backdrop itself.
		fireEvent.mouseDown( backdrop );
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'tags the primary button as danger when prop set', () => {
		const { getByText } = render(
			<ConfirmModal
				title=""
				body=""
				danger
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Confirm' ).className ).toContain( '--danger' );
	} );

	it( 'honors custom confirmLabel/cancelLabel', () => {
		const { getByText } = render(
			<ConfirmModal
				title=""
				body=""
				confirmLabel="Yeet"
				cancelLabel="Nope"
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Yeet' ) ).not.toBeNull();
		expect( getByText( 'Nope' ) ).not.toBeNull();
	} );
} );

describe( 'PromptModal', () => {
	it( 'submits the trimmed input value on Enter', () => {
		const onConfirm = jest.fn();
		const { container } = render(
			<PromptModal
				title="Rename"
				body=""
				initialValue="alpha"
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		const input = container.querySelector( 'input' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConfirm ).toHaveBeenCalledWith( 'alpha' );
	} );

	it( 'submits when Save is clicked', () => {
		const onConfirm = jest.fn();
		const { getByText, container } = render(
			<PromptModal
				title=""
				body=""
				initialValue=""
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		const input = container.querySelector( 'input' );
		fireEvent.change( input, { target: { value: 'beta' } } );
		fireEvent.click( getByText( 'Save' ) );
		expect( onConfirm ).toHaveBeenCalledWith( 'beta' );
	} );

	it( 'disables Save when value is empty', () => {
		const { getByText } = render(
			<PromptModal
				title=""
				body=""
				initialValue=""
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Save' ).disabled ).toBe( true );
	} );

	it( 'disables Save when value fails pattern and shows hint', () => {
		const { getByText, container } = render(
			<PromptModal
				title=""
				body=""
				initialValue="bad value"
				pattern={ /^[a-z-]+$/ }
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Save' ).disabled ).toBe( true );
		const hint = container.querySelector( '.topology-modal__hint' );
		expect( hint.textContent ).toMatch( /Invalid/ );
	} );

	it( 'no-ops on Enter when value is empty', () => {
		const onConfirm = jest.fn();
		const { container } = render(
			<PromptModal
				title=""
				body=""
				initialValue=""
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		fireEvent.keyDown( container.querySelector( 'input' ), {
			key: 'Enter',
		} );
		expect( onConfirm ).not.toHaveBeenCalled();
	} );

	it( 'invokes onCancel on Cancel button click', () => {
		const onCancel = jest.fn();
		const { getByText } = render(
			<PromptModal
				title=""
				body=""
				onConfirm={ () => {} }
				onCancel={ onCancel }
			/>
		);
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'removes ESC listener on unmount (no leak)', () => {
		const onCancel = jest.fn();
		const { unmount } = render(
			<PromptModal
				title=""
				body=""
				initialValue="x"
				onConfirm={ () => {} }
				onCancel={ onCancel }
			/>
		);
		act( () => unmount() );
		fireEvent.keyDown( document, { key: 'Escape' } );
		expect( onCancel ).not.toHaveBeenCalled();
	} );
} );

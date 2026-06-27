/**
 * Modal — ConfirmModal + PromptModal share a backdrop shell with
 * ESC-to-dismiss and click-backdrop-to-dismiss. Tests stay focused on
 * those two affordances + the prompt's pattern-validity branch.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { ConfirmModal, PromptModal, ModalShell, NewNodeModal } from '../Modal';

describe( 'ModalShell', () => {
	it( 'renders its title + children', () => {
		const { getByText } = render(
			<ModalShell title="My Verb" onDismiss={ () => {} }>
				<div>inner content</div>
			</ModalShell>
		);
		expect( getByText( 'My Verb' ) ).not.toBeNull();
		expect( getByText( 'inner content' ) ).not.toBeNull();
	} );

	it( 'invokes onDismiss on ESC keydown', () => {
		const onDismiss = jest.fn();
		render(
			<ModalShell title="" onDismiss={ onDismiss }>
				<div />
			</ModalShell>
		);
		fireEvent.keyDown( document, { key: 'Escape' } );
		expect( onDismiss ).toHaveBeenCalled();
	} );

	it( 'invokes onDismiss on backdrop click but not on inner dialog click', () => {
		const onDismiss = jest.fn();
		const { baseElement } = render(
			<ModalShell title="" onDismiss={ onDismiss }>
				<div />
			</ModalShell>
		);
		const backdrop = baseElement.querySelector(
			'.topology-modal-backdrop'
		);
		const dialog = baseElement.querySelector( '.topology-modal' );
		fireEvent.mouseDown( dialog );
		expect( onDismiss ).not.toHaveBeenCalled();
		fireEvent.mouseDown( backdrop );
		expect( onDismiss ).toHaveBeenCalled();
	} );

	it( 'portals the backdrop to <body> under a theme wrapper so it escapes nested stacking contexts', () => {
		// A fixed-position backdrop rendered inside a stacking-context ancestor (the
		// inspector dock's z-index:2 console) paints BELOW the portaled panel header.
		// Portaling to <body> escapes every nested context; the theme wrapper keeps
		// --paper / --ink in scope.
		render(
			<div className="dock">
				<ModalShell title="x" onDismiss={ () => {} }>
					<div />
				</ModalShell>
			</div>
		);
		const dock = document.body.querySelector( '.dock' );
		const backdrop = document.body.querySelector(
			'.topology-modal-backdrop'
		);
		expect( backdrop ).not.toBeNull();
		expect( dock.contains( backdrop ) ).toBe( false );
		expect(
			backdrop.closest( '.topology-app.newspack-nodes-theme' )
		).not.toBeNull();
	} );
} );

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
		const { baseElement } = render(
			<ConfirmModal
				title=""
				body=""
				onConfirm={ () => {} }
				onCancel={ onCancel }
			/>
		);
		const backdrop = baseElement.querySelector(
			'.topology-modal-backdrop'
		);
		const dialog = baseElement.querySelector( '.topology-modal' );
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
		const { baseElement } = render(
			<PromptModal
				title="Rename"
				body=""
				initialValue="alpha"
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		const input = baseElement.querySelector( 'input' );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onConfirm ).toHaveBeenCalledWith( 'alpha' );
	} );

	it( 'submits when Save is clicked', () => {
		const onConfirm = jest.fn();
		const { getByText, baseElement } = render(
			<PromptModal
				title=""
				body=""
				initialValue=""
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		const input = baseElement.querySelector( 'input' );
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
		const { getByText, baseElement } = render(
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
		const hint = baseElement.querySelector( '.topology-modal__hint' );
		expect( hint.textContent ).toMatch( /Invalid/ );
	} );

	it( 'no-ops on Enter when value is empty', () => {
		const onConfirm = jest.fn();
		const { baseElement } = render(
			<PromptModal
				title=""
				body=""
				initialValue=""
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		fireEvent.keyDown( baseElement.querySelector( 'input' ), {
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

describe( 'NewNodeModal', () => {
	const baseProps = {
		shellName: 'Partition',
		defaultName: 'partition1',
		argSchema: [
			{ name: 'topic', required: true },
			{ name: 'segment_size', default: '4096' },
		],
		onConfirm: () => {},
		onCancel: () => {},
	};

	it( 'renders a name input pre-filled with the default and an args input', () => {
		const { baseElement } = render( <NewNodeModal { ...baseProps } /> );
		const inputs = baseElement.querySelectorAll( 'input' );
		expect( inputs ).toHaveLength( 2 );
		expect( inputs[ 0 ].value ).toBe( 'partition1' );
		expect( inputs[ 1 ].value ).toBe( '' );
	} );

	it( 'shows the argSchema template as a placeholder/hint on the args input', () => {
		const { baseElement } = render( <NewNodeModal { ...baseProps } /> );
		// Template should expose required asterisk + default-marker syntax so
		// the user knows what the field expects.
		expect( baseElement.textContent ).toMatch( /topic\*/ );
		expect( baseElement.textContent ).toMatch( /segment_size=4096/ );
	} );

	it( 'submits { name, args } on Save click', () => {
		const onConfirm = jest.fn();
		const { baseElement, getByText } = render(
			<NewNodeModal { ...baseProps } onConfirm={ onConfirm } />
		);
		const [ nameInput, argsInput ] =
			baseElement.querySelectorAll( 'input' );
		fireEvent.change( nameInput, { target: { value: 'mypart' } } );
		fireEvent.change( argsInput, {
			target: { value: 'mytopic 8192' },
		} );
		fireEvent.click( getByText( 'Add' ) );
		expect( onConfirm ).toHaveBeenCalledWith( {
			name: 'mypart',
			args: 'mytopic 8192',
		} );
	} );

	it( 'submits on Enter inside either input', () => {
		const onConfirm = jest.fn();
		const { baseElement } = render(
			<NewNodeModal { ...baseProps } onConfirm={ onConfirm } />
		);
		const [ nameInput, argsInput ] =
			baseElement.querySelectorAll( 'input' );
		fireEvent.change( argsInput, { target: { value: 'x' } } );
		fireEvent.keyDown( nameInput, { key: 'Enter' } );
		expect( onConfirm ).toHaveBeenCalledTimes( 1 );
		fireEvent.keyDown( argsInput, { key: 'Enter' } );
		expect( onConfirm ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'disables Add when name is empty (args can be empty)', () => {
		const { getByText, baseElement } = render(
			<NewNodeModal { ...baseProps } />
		);
		const [ nameInput ] = baseElement.querySelectorAll( 'input' );
		fireEvent.change( nameInput, { target: { value: '' } } );
		expect( getByText( 'Add' ).disabled ).toBe( true );
	} );

	it( 'cancels on Cancel button click', () => {
		const onCancel = jest.fn();
		const { getByText } = render(
			<NewNodeModal { ...baseProps } onCancel={ onCancel } />
		);
		fireEvent.click( getByText( 'Cancel' ) );
		expect( onCancel ).toHaveBeenCalled();
	} );

	it( 'focuses the name input on mount (user can rename immediately)', () => {
		const { baseElement } = render( <NewNodeModal { ...baseProps } /> );
		const [ nameInput ] = baseElement.querySelectorAll( 'input' );
		expect( document.activeElement ).toBe( nameInput );
	} );
} );

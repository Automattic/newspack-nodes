/**
 * Modal — ConfirmModal + PromptModal share a backdrop shell with
 * ESC-to-dismiss and click-backdrop-to-dismiss. Tests stay focused on
 * those two affordances + the prompt's pattern-validity branch.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { ConfirmModal, PromptModal, ModalShell, NewNodeModal } from '../Modal';

describe( 'ModalShell', () => {
	it( 'renders its title + children', () => {
		const { baseElement, getByText } = render(
			<ModalShell title="My Verb" onDismiss={ () => {} }>
				<div>inner content</div>
			</ModalShell>
		);
		expect( getByText( 'My Verb' ) ).not.toBeNull();
		expect( getByText( 'inner content' ) ).not.toBeNull();
		expect( baseElement.querySelector( '.topology-modal' ).className ).toBe(
			'topology-modal newspack-nodes-modal'
		);
		expect(
			baseElement.querySelector( '.topology-modal__header' ).className
		).toBe( 'topology-modal__header newspack-nodes-modal__header' );
		expect(
			baseElement.querySelector( '.topology-modal__title' ).className
		).toBe( 'topology-modal__title newspack-nodes-modal__title' );
		expect(
			baseElement.querySelector( '.topology-modal__close' ).className
		).toBe( 'topology-modal__close newspack-nodes-modal__close' );
	} );

	it( 'renders an X close button in the corner that invokes onDismiss', () => {
		const onDismiss = jest.fn();
		const { baseElement } = render(
			<ModalShell title="x" onDismiss={ onDismiss }>
				<div />
			</ModalShell>
		);
		const close = baseElement.querySelector( '.topology-modal__close' );
		expect( close ).not.toBeNull();
		expect( close.getAttribute( 'aria-label' ) ).toBe( 'Close' );
		fireEvent.click( close );
		expect( onDismiss ).toHaveBeenCalled();
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

	it( 'portals the backdrop to <body> under the canonical non-graph provider', () => {
		// Portaled to <body> to escape the dock's stacking context + dim all.
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
		const provider = backdrop.parentElement;
		expect( provider.className ).toBe(
			'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( provider.parentElement ).toBe( document.body );
		expect( provider.classList.contains( 'topology-app' ) ).toBe( false );
	} );

	it( 'centers the dialog over the overlay panel (not the viewport) when one is present', () => {
		// Whole-page dim, but the dialog centres over the panel, not viewport.
		const panel = document.createElement( 'div' );
		panel.className = 'nodes-debug__panel';
		document.body.appendChild( panel );
		render(
			<ModalShell title="x" onDismiss={ () => {} }>
				<div />
			</ModalShell>
		);
		const dialog = document.body.querySelector( '.topology-modal' );
		expect( dialog.style.position ).toBe( 'absolute' );
		expect( dialog.style.transform ).toContain( 'translate' );
		panel.remove();
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
		expect( getByText( 'Confirm' ).className ).toContain( 'is-danger' );
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

	it( 'drops button-primary while disabled so core cannot force #e2e2e2', () => {
		// `.wp-core-ui .button-primary:disabled` sets its grey with !important,
		// which no selector outranks — so a disabled primary must stop being one.
		const { getByText, baseElement } = render(
			<PromptModal
				title=""
				body=""
				initialValue=""
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Save' ).className ).not.toMatch( /button-primary/ );

		fireEvent.change( baseElement.querySelector( 'input' ), {
			target: { value: 'gamma' },
		} );
		expect( getByText( 'Save' ).className ).toMatch( /button-primary/ );
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

	it( 'renders a name input + one node_schema field per argSchema entry', () => {
		const { baseElement } = render( <NewNodeModal { ...baseProps } /> );
		const labels = [
			...baseElement.querySelectorAll( '.topology-edit-row__label' ),
		].map( ( l ) => l.textContent );
		expect( labels ).toEqual( [ 'topic *', 'segment_size' ] );
		// name input + the two constructor fields.
		expect( baseElement.querySelectorAll( 'input' ) ).toHaveLength( 3 );
		expect(
			baseElement.querySelector( '#newspack-nodes-newnode-name' ).value
		).toBe( 'partition1' );
	} );

	it( 'shows each arg schema default as its field placeholder', () => {
		const { baseElement } = render( <NewNodeModal { ...baseProps } /> );
		expect(
			baseElement.querySelector( '#topology-ctor-segment_size' )
				.placeholder
		).toBe( '4096' );
	} );

	it( 'submits { name, args } serialized from the per-field values', () => {
		const onConfirm = jest.fn();
		const { baseElement, getByText } = render(
			<NewNodeModal { ...baseProps } onConfirm={ onConfirm } />
		);
		fireEvent.change(
			baseElement.querySelector( '#newspack-nodes-newnode-name' ),
			{ target: { value: 'mypart' } }
		);
		fireEvent.change( baseElement.querySelector( '#topology-ctor-topic' ), {
			target: { value: 'mytopic' },
		} );
		fireEvent.change(
			baseElement.querySelector( '#topology-ctor-segment_size' ),
			{ target: { value: '8192' } }
		);
		fireEvent.click( getByText( 'Add' ) );
		expect( onConfirm ).toHaveBeenCalledWith( {
			name: 'mypart',
			args: 'mytopic 8192',
		} );
	} );

	it( 'fills a blank field from its schema default on submit', () => {
		const onConfirm = jest.fn();
		const { baseElement, getByText } = render(
			<NewNodeModal { ...baseProps } onConfirm={ onConfirm } />
		);
		fireEvent.change(
			baseElement.querySelector( '#newspack-nodes-newnode-name' ),
			{ target: { value: 'p' } }
		);
		fireEvent.change( baseElement.querySelector( '#topology-ctor-topic' ), {
			target: { value: 'mytopic' },
		} );
		// segment_size left blank → its 4096 default fills the slot.
		fireEvent.click( getByText( 'Add' ) );
		expect( onConfirm ).toHaveBeenCalledWith( {
			name: 'p',
			args: 'mytopic 4096',
		} );
	} );

	it( 'submits on Enter inside the name input', () => {
		const onConfirm = jest.fn();
		const { baseElement } = render(
			<NewNodeModal { ...baseProps } onConfirm={ onConfirm } />
		);
		const nameInput = baseElement.querySelector(
			'#newspack-nodes-newnode-name'
		);
		fireEvent.change( nameInput, { target: { value: 'p' } } );
		fireEvent.keyDown( nameInput, { key: 'Enter' } );
		expect( onConfirm ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'disables Add when name is empty', () => {
		const { getByText, baseElement } = render(
			<NewNodeModal { ...baseProps } defaultName="" />
		);
		fireEvent.change(
			baseElement.querySelector( '#newspack-nodes-newnode-name' ),
			{ target: { value: '' } }
		);
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
		expect( document.activeElement ).toBe(
			baseElement.querySelector( '#newspack-nodes-newnode-name' )
		);
	} );
} );

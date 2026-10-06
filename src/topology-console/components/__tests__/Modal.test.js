/**
 * Modal — ConfirmModal + PromptModal share a backdrop shell with
 * ESC-to-dismiss and click-backdrop-to-dismiss. Tests stay focused on
 * those two affordances + the prompt's pattern-validity branch.
 */

import { render, fireEvent, act } from '@testing-library/react';
import {
	ConfirmModal,
	PromptModal,
	ModalShell,
	ModalField,
	NewNodeModal,
} from '../Modal';

describe( 'ModalShell', () => {
	// A failed assertion skips the rest of its test, so the stub panel a
	// panel-anchoring test appends is torn down here, not inline.
	afterEach( () => {
		document
			.querySelectorAll( '.nodes-debug__panel' )
			.forEach( ( el ) => el.remove() );
	} );

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

	it( 'renders its panel as a noValidate form when given onSubmit', () => {
		const onSubmit = jest.fn();
		const { baseElement } = render(
			<ModalShell title="t" onDismiss={ () => {} } onSubmit={ onSubmit }>
				<input type="url" defaultValue="not a url" />
			</ModalShell>
		);
		const panel = baseElement.querySelector( '.topology-modal' );
		expect( panel.tagName ).toBe( 'FORM' );
		expect( panel.noValidate ).toBe( true );
		expect( panel.getAttribute( 'role' ) ).toBe( 'dialog' );
		expect( panel.parentElement.className ).toBe(
			'topology-modal-backdrop'
		);
		// The return is false when the handler prevented the default.
		expect( fireEvent.submit( panel ) ).toBe( false );
		expect( onSubmit ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'keeps its panel a div without onSubmit', () => {
		const { baseElement } = render(
			<ModalShell title="t" onDismiss={ () => {} }>
				<div />
			</ModalShell>
		);
		expect( baseElement.querySelector( '.topology-modal' ).tagName ).toBe(
			'DIV'
		);
	} );

	it( 'stops a submit at its own panel', () => {
		const outer = jest.fn();
		const inner = jest.fn();
		const { baseElement } = render(
			<form onSubmit={ outer }>
				<ModalShell title="t" onDismiss={ () => {} } onSubmit={ inner }>
					<div />
				</ModalShell>
			</form>
		);
		fireEvent.submit( baseElement.querySelector( '.topology-modal' ) );
		expect( inner ).toHaveBeenCalledTimes( 1 );
		expect( outer ).not.toHaveBeenCalled();
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

	// A stub overlay panel of the given box, appended to <body>.
	const overlayPanel = ( { width, height, left = 380, top = 140 } ) => {
		const panel = document.createElement( 'div' );
		panel.className = 'nodes-debug__panel';
		panel.getBoundingClientRect = () => ( {
			left,
			top,
			width,
			height,
			right: left + width,
			bottom: top + height,
			x: left,
			y: top,
		} );
		document.body.appendChild( panel );
		return panel;
	};

	// Every inline value the panel anchor writes, read as one shape so an
	// unexpected extra fails alongside a wrong one.
	const positioning = ( dialog ) => ( {
		position: dialog.style.position,
		left: dialog.style.left,
		top: dialog.style.top,
		maxW: dialog.style.getPropertyValue( '--nodes-modal-max-w' ),
		maxH: dialog.style.getPropertyValue( '--nodes-modal-max-h' ),
	} );

	const VIEWPORT_CENTRED = {
		position: '',
		left: '',
		top: '',
		maxW: '',
		maxH: '',
	};

	const renderShell = ( container ) =>
		render(
			<ModalShell title="x" onDismiss={ () => {} }>
				<div />
			</ModalShell>,
			container ? { container } : undefined
		);

	it( 'centres the dialog on its overlay panel and bounds it to that panel', () => {
		// Whole-page dim, but the dialog belongs to the panel: centred on it
		// in both axes and capped to its box, so no edge escapes the overlay.
		renderShell( overlayPanel( { width: 900, height: 620 } ) );
		const dialog = document.body.querySelector( '.topology-modal' );
		// The panel's box reaches the stylesheet as a cap it narrows the
		// standing max-width with, rather than as a replacement for it.
		expect( positioning( dialog ) ).toEqual( {
			position: 'absolute',
			left: '830px',
			top: '450px',
			maxW: '868px',
			maxH: '588px',
		} );
		expect( dialog.style.transform ).toBe( 'translate(-50%, -50%)' );
	} );

	it( 'ignores an overlay panel the dialog does not render inside', () => {
		// The station mounts the floating overlay beside every tab, so a Console
		// tab dialog must not follow a panel that merely happens to be open.
		overlayPanel( { width: 900, height: 620 } );
		renderShell();
		expect(
			positioning( document.body.querySelector( '.topology-modal' ) )
		).toEqual( VIEWPORT_CENTRED );
	} );

	it( 'ignores a containing panel too small to hold a dialog', () => {
		// Below the dialog's own floors the caps cannot contain it, so
		// anchoring would paint it outside the panel it belongs to.
		renderShell( overlayPanel( { width: 240, height: 118 } ) );
		expect(
			positioning( document.body.querySelector( '.topology-modal' ) )
		).toEqual( VIEWPORT_CENTRED );
	} );

	it( 're-measures when its panel is resized', () => {
		let observed = null;
		const disconnect = jest.fn();
		window.ResizeObserver = class {
			constructor( cb ) {
				this.cb = cb;
			}
			observe( el ) {
				observed = { el, cb: this.cb };
			}
			disconnect = disconnect;
		};
		const panel = overlayPanel( { width: 900, height: 620 } );
		renderShell( panel );
		expect( observed.el ).toBe( panel );
		panel.getBoundingClientRect = () => ( {
			left: 100,
			top: 60,
			width: 500,
			height: 400,
			right: 600,
			bottom: 460,
			x: 100,
			y: 60,
		} );
		act( () => observed.cb() );
		expect(
			positioning( document.body.querySelector( '.topology-modal' ) )
		).toEqual( {
			position: 'absolute',
			left: '350px',
			top: '260px',
			maxW: '468px',
			maxH: '368px',
		} );
		delete window.ResizeObserver;
	} );

	it( 'lets a wide dialog grow while open but never shrink', () => {
		// It sizes to live content; a poll that narrows it would slide its
		// centred edges under the pointer.
		const observers = [];
		window.ResizeObserver = class {
			constructor( cb ) {
				this.cb = cb;
			}
			observe( el, options ) {
				observers.push( { el, cb: this.cb, options } );
			}
			disconnect() {}
		};
		const { baseElement } = render(
			<ModalShell title="Runtime" onDismiss={ () => {} } wide>
				<div>grid</div>
			</ModalShell>
		);
		const modal = baseElement.querySelector( '.topology-modal' );
		const own = observers.find( ( o ) => o.el === modal );
		// The border box, which the dialog's border-box sizing makes the same
		// box its min-width sets: a content box would grow by the border.
		const measure = ( width ) =>
			act( () =>
				own.cb( [ { borderBoxSize: [ { inlineSize: width } ] } ] )
			);

		measure( 1100 );
		measure( 1040 );

		expect( own.options ).toEqual( { box: 'border-box' } );
		expect( modal.style.getPropertyValue( '--nodes-modal-grown' ) ).toBe(
			'1100px'
		);
		delete window.ResizeObserver;
	} );

	it( 'disconnects the panel observer on unmount (no leak)', () => {
		const disconnect = jest.fn();
		window.ResizeObserver = class {
			constructor( cb ) {
				this.cb = cb;
			}
			observe() {}
			disconnect = disconnect;
		};
		const { unmount } = renderShell(
			overlayPanel( { width: 900, height: 620 } )
		);
		act( () => unmount() );
		expect( disconnect ).toHaveBeenCalled();
		delete window.ResizeObserver;
	} );

	it( 'falls back to the window where ResizeObserver is missing', () => {
		const panel = overlayPanel( { width: 900, height: 620 } );
		renderShell( panel );
		panel.getBoundingClientRect = () => ( {
			left: 100,
			top: 60,
			width: 500,
			height: 400,
			right: 600,
			bottom: 460,
			x: 100,
			y: 60,
		} );
		act( () => {
			window.dispatchEvent( new window.Event( 'resize' ) );
		} );
		expect(
			positioning( document.body.querySelector( '.topology-modal' ) )
		).toEqual( {
			position: 'absolute',
			left: '350px',
			top: '260px',
			maxW: '468px',
			maxH: '368px',
		} );
	} );

	it( 'leaves the dialog viewport-centred when no overlay panel is present', () => {
		renderShell();
		expect(
			positioning( document.body.querySelector( '.topology-modal' ) )
		).toEqual( VIEWPORT_CENTRED );
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

// jsdom performs no implicit submission, so Enter is the form's submit event.
const panelForm = ( baseElement ) =>
	baseElement.querySelector( 'form.topology-modal' );

describe( 'PromptModal', () => {
	it( 'confirms the input value when its form submits', () => {
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
		fireEvent.submit( panelForm( baseElement ) );
		expect( onConfirm ).toHaveBeenCalledWith( 'alpha' );
	} );

	it( 'leaves Enter in the input to the form', () => {
		const onConfirm = jest.fn();
		const { baseElement } = render(
			<PromptModal
				title=""
				body=""
				initialValue="alpha"
				onConfirm={ onConfirm }
				onCancel={ () => {} }
			/>
		);
		const input = baseElement.querySelector( 'input' );
		expect( input.form ).toBe( panelForm( baseElement ) );
		expect( fireEvent.keyDown( input, { key: 'Enter' } ) ).toBe( true );
		expect( onConfirm ).not.toHaveBeenCalled();
	} );

	it( 'makes Save the submit and every other button plain', () => {
		const { getByText, baseElement } = render(
			<PromptModal
				title=""
				body=""
				initialValue="alpha"
				onConfirm={ () => {} }
				onCancel={ () => {} }
			/>
		);
		expect( getByText( 'Save' ).type ).toBe( 'submit' );
		const others = [
			...panelForm( baseElement ).querySelectorAll( 'button' ),
		].filter( ( b ) => b !== getByText( 'Save' ) );
		expect( others.map( ( b ) => b.textContent ) ).toEqual( [
			'×',
			'Cancel',
		] );
		others.forEach( ( b ) => expect( b.type ).toBe( 'button' ) );
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

	it( 'adds when its form submits', () => {
		const onConfirm = jest.fn();
		const { baseElement } = render(
			<NewNodeModal { ...baseProps } onConfirm={ onConfirm } />
		);
		fireEvent.change(
			baseElement.querySelector( '#newspack-nodes-newnode-name' ),
			{ target: { value: 'heron' } }
		);
		fireEvent.change( baseElement.querySelector( '#topology-ctor-topic' ), {
			target: { value: 'egret' },
		} );
		fireEvent.submit( panelForm( baseElement ) );
		expect( onConfirm ).toHaveBeenCalledWith( {
			name: 'heron',
			args: 'egret 4096',
		} );
	} );

	it( 'keeps Enter in a json argument for the newline', () => {
		const onConfirm = jest.fn();
		const { baseElement } = render(
			<NewNodeModal
				{ ...baseProps }
				argSchema={ [ { name: 'payload', type: 'json' } ] }
				onConfirm={ onConfirm }
			/>
		);
		const payload = baseElement.querySelector( '#topology-ctor-payload' );
		expect( payload.tagName ).toBe( 'TEXTAREA' );
		expect( fireEvent.keyDown( payload, { key: 'Enter' } ) ).toBe( true );
		expect( onConfirm ).not.toHaveBeenCalled();
	} );

	it( 'holds Enter in a node path field while it refuses its draft', () => {
		const onConfirm = jest.fn();
		const { baseElement, getByText } = render(
			<NewNodeModal
				{ ...baseProps }
				argSchema={ [ { name: 'route', type: 'node_name' } ] }
				onConfirm={ onConfirm }
			/>
		);
		const route = baseElement.querySelector( '#topology-ctor-route' );
		fireEvent.change( route, { target: { value: 'heron/p3' } } );
		fireEvent.change( route, { target: { value: 'heron p3' } } );
		// A prevented keydown is what cancels the browser's implicit submit.
		expect( fireEvent.keyDown( route, { key: 'Enter' } ) ).toBe( false );
		expect( getByText( 'Add' ).disabled ).toBe( true );
		fireEvent.change( route, { target: { value: 'heron/p4' } } );
		expect( fireEvent.keyDown( route, { key: 'Enter' } ) ).toBe( true );
		fireEvent.submit( panelForm( baseElement ) );
		expect( onConfirm ).toHaveBeenCalledWith( {
			name: 'partition1',
			args: 'heron/p4',
		} );
	} );

	it( 'makes Add the submit and every other button plain', () => {
		const { baseElement, getByText } = render(
			<NewNodeModal { ...baseProps } />
		);
		fireEvent.change( baseElement.querySelector( '#topology-ctor-topic' ), {
			target: { value: 'mytopic' },
		} );
		expect( getByText( 'Add' ).type ).toBe( 'submit' );
		const others = [
			...panelForm( baseElement ).querySelectorAll( 'button' ),
		].filter( ( b ) => b !== getByText( 'Add' ) );
		// ×, the filled field's reset, and Cancel.
		expect( others ).toHaveLength( 3 );
		others.forEach( ( b ) => expect( b.type ).toBe( 'button' ) );
	} );

	it( 'disables Add, and ignores its click, while a node path field refuses', () => {
		const onConfirm = jest.fn();
		const { baseElement, getByText } = render(
			<NewNodeModal
				{ ...baseProps }
				argSchema={ [
					{ name: 'route', type: 'node_name' },
					{ name: 'segment_size', default: '4096' },
				] }
				onConfirm={ onConfirm }
			/>
		);
		const route = baseElement.querySelector( '#topology-ctor-route' );
		fireEvent.change( route, { target: { value: 'heron/p3' } } );
		fireEvent.change( route, { target: { value: 'heron p3' } } );
		expect( getByText( 'Add' ).disabled ).toBe( true );
		fireEvent.click( getByText( 'Add' ) );
		expect( onConfirm ).not.toHaveBeenCalled();
		fireEvent.change( route, { target: { value: 'heron/p4' } } );
		expect( getByText( 'Add' ).disabled ).toBe( false );
		fireEvent.click( getByText( 'Add' ) );
		expect( onConfirm ).toHaveBeenCalledWith( {
			name: 'partition1',
			args: 'heron/p4 4096',
		} );
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

describe( 'ModalField', () => {
	it( 'labels the control it wraps and gives it the one id', () => {
		const { container } = render(
			<ModalField id="nodes-field-route" label="Route">
				<select defaultValue="demo.p3">
					<option value="demo.p3">demo.p3</option>
				</select>
			</ModalField>
		);
		const label = container.querySelector( 'label' );
		expect( label.className ).toBe( 'topology-modal__label' );
		expect( label.htmlFor ).toBe( 'nodes-field-route' );
		expect( label.textContent ).toBe( 'Route' + 'demo.p3' );
		expect( label.querySelector( 'select' ).id ).toBe(
			'nodes-field-route'
		);
	} );

	it( 'spans the row when wide', () => {
		const { container } = render(
			<ModalField id="nodes-field-body" label="Body" wide>
				<textarea rows={ 6 } readOnly />
			</ModalField>
		);
		expect( container.querySelector( 'label' ).className ).toBe(
			'topology-modal__label topology-modal__label--wide'
		);
		const control = container.querySelector( 'label > textarea' );
		expect( control.id ).toBe( 'nodes-field-body' );
		expect( control.rows ).toBe( 6 );
	} );
} );

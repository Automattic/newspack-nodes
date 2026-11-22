/**
 * The shared plain-DOM modal shell: the one backdrop + dialog box control,
 * in place of per-dashboard selectors.
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import { useEffect, useRef, useState } from '@wordpress/element';
import Modal, {
	Confirm,
	ModalHeader,
	ModalTitleId,
	BodyPortal,
} from '../Modal';
import { MODAL_EXIT_MS } from '../../hooks/useModalExit';

const backdropOf = ( dialog ) =>
	dialog.closest( '.newspack-nodes-modal__backdrop' );

afterEach( () => jest.useRealTimers() );

test( 'it renders a labelled dialog carrying the canonical modal role', () => {
	render(
		<Modal ariaLabel="Add thing" onClose={ () => {} }>
			<p>body</p>
		</Modal>
	);

	const dialog = screen.getByRole( 'dialog' );
	expect( dialog.getAttribute( 'aria-label' ) ).toBe( 'Add thing' );
	expect( dialog.getAttribute( 'aria-modal' ) ).toBe( 'true' );
	expect( dialog.className ).toContain( 'newspack-nodes-modal' );
	expect( screen.getByText( 'body' ) ).toBeTruthy();
} );

test( 'its header holds the title and a labelled icon close as siblings', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	render(
		<Modal ariaLabel="Quarry notes 62" onClose={ onClose }>
			<ModalHeader title="Quarry notes 62" onClose={ onClose } />
		</Modal>
	);

	const title = screen.getByText( 'Quarry notes 62' );
	const close = screen.getByRole( 'button', { name: 'Close' } );
	const header = title.parentElement;
	expect( header.tagName ).toBe( 'HEADER' );
	expect( header.className ).toBe( 'newspack-nodes-modal__header' );
	expect( title.className ).toBe( 'newspack-nodes-modal__title' );
	expect( close.parentElement ).toBe( header );
	expect( close.className ).toBe( 'newspack-nodes-modal__close' );
	expect( close.getAttribute( 'type' ) ).toBe( 'button' );
	expect( close.textContent ).toBe( '' );
	expect( close.querySelector( 'svg' ).getAttribute( 'viewBox' ) ).toBe(
		'0 0 24 24'
	);

	fireEvent.click( close );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'its header carries a long title whole in the title attribute', () => {
	const long =
		'Rebalance every partition of the heron-ledger-archive fleet onto the egret spokes';
	render(
		<Modal ariaLabel={ long } onClose={ () => {} }>
			<ModalHeader title={ long } onClose={ () => {} } />
		</Modal>
	);

	const title = document.querySelector( '.newspack-nodes-modal__title' );
	expect( title.textContent ).toBe( long );
	expect( title.getAttribute( 'title' ) ).toBe( long );
} );

test( 'a dialog headed by ModalHeader is named by its title alone', () => {
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader title="Quarry ledger 81" onClose={ () => {} } />
		</Modal>
	);

	const dialog = screen.getByRole( 'dialog', { name: 'Quarry ledger 81' } );
	const title = dialog.querySelector( 'h2.newspack-nodes-modal__title' );
	expect( dialog.hasAttribute( 'aria-label' ) ).toBe( false );
	expect( title.id ).not.toBe( '' );
	expect( dialog.getAttribute( 'aria-labelledby' ) ).toBe( title.id );
} );

test( 'its header labels the close in the words the caller hands it', () => {
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader
				title="t"
				onClose={ () => {} }
				closeLabel="Cerrar 81"
			/>
		</Modal>
	);

	expect( screen.getByRole( 'button', { name: 'Cerrar 81' } ) ).toBeTruthy();
} );

test( 'its header refuses to render outside a dialog that it can name', () => {
	const quiet = jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	try {
		expect( () =>
			render( <ModalHeader title="t" onClose={ () => {} } /> )
		).toThrow( 'ModalHeader' );
	} finally {
		quiet.mockRestore();
	}
} );

test( 'its header hands the close button to the ref it is given', () => {
	const ref = { current: null };
	render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<ModalHeader title="t" onClose={ () => {} } closeRef={ ref } />
		</Modal>
	);

	expect( ref.current ).toBe(
		screen.getByRole( 'button', { name: 'Close' } )
	);
} );

test( 'escape closes it', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	render(
		<Modal ariaLabel="x" onClose={ onClose }>
			b
		</Modal>
	);

	fireEvent.keyDown( document, { key: 'Escape' } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'a backdrop mousedown closes it but a click inside does not', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	render(
		<Modal ariaLabel="x" onClose={ onClose }>
			<p>body</p>
		</Modal>
	);

	fireEvent.mouseDown( screen.getByText( 'body' ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).not.toHaveBeenCalled();

	fireEvent.mouseDown(
		document.body.querySelector( '.newspack-nodes-modal__backdrop' )
	);
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'Tab and Shift+Tab wrap focus inside the dialog', () => {
	render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<button type="button">first-417</button>
			<input aria-label="middle-417" />
			<button type="button">last-417</button>
		</Modal>
	);
	const first = screen.getByText( 'first-417' );
	const last = screen.getByText( 'last-417' );

	last.focus();
	fireEvent.keyDown( last, { key: 'Tab' } );
	expect( document.activeElement ).toBe( first );

	fireEvent.keyDown( first, { key: 'Tab', shiftKey: true } );
	expect( document.activeElement ).toBe( last );
} );

test( 'Tab inside the dialog away from its edges is left to the browser', () => {
	render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<button type="button">first-418</button>
			<button type="button">last-418</button>
		</Modal>
	);
	const first = screen.getByText( 'first-418' );
	first.focus();

	expect( fireEvent.keyDown( first, { key: 'Tab' } ) ).toBe( true );
	expect( document.activeElement ).toBe( first );
} );

test( 'closing it returns focus to what opened it', () => {
	render( <button type="button">opener-419</button> );
	const opener = screen.getByText( 'opener-419' );
	opener.focus();
	const { unmount } = render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<button type="button">inside-419</button>
		</Modal>
	);
	screen.getByText( 'inside-419' ).focus();

	unmount();
	expect( document.activeElement ).toBe( opener );
} );

test( 'closing it returns focus to the opener even when a child took focus on mount', () => {
	const Autofocus = () => {
		const ref = useRef( null );
		useEffect( () => ref.current.focus(), [] );
		return <input ref={ ref } aria-label="field-612" />;
	};
	render( <button type="button">opener-612</button> );
	const opener = screen.getByText( 'opener-612' );
	opener.focus();
	const { unmount } = render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<Autofocus />
		</Modal>
	);
	expect( document.activeElement ).toBe(
		screen.getByLabelText( 'field-612' )
	);

	unmount();
	expect( document.activeElement ).toBe( opener );
} );

test( 'closing it returns focus to the element returnFocus names, over what held focus', () => {
	render(
		<>
			<button type="button">trigger-833</button>
			<button type="button">elsewhere-833</button>
		</>
	);
	const trigger = { current: screen.getByText( 'trigger-833' ) };
	screen.getByText( 'elsewhere-833' ).focus();
	const { unmount } = render(
		<Modal ariaLabel="x" onClose={ () => {} } returnFocus={ trigger }>
			<button type="button">inside-833</button>
		</Modal>
	);
	screen.getByText( 'inside-833' ).focus();

	unmount();
	expect( document.activeElement ).toBe( trigger.current );
} );

test( 'the listener is removed on unmount', () => {
	const onClose = jest.fn();
	const { unmount } = render(
		<Modal ariaLabel="x" onClose={ onClose }>
			b
		</Modal>
	);

	unmount();
	fireEvent.keyDown( document, { key: 'Escape' } );
	expect( onClose ).not.toHaveBeenCalled();
} );

// The topology console's ModalShell renders through this too, rather than its
// own copy of the three skin classes, the `display: contents`, the document
// guard and the body target. Two spellings of one contract drift; this is one.
test( 'BodyPortal is the shared host both dialogs render through', () => {
	const { container } = render(
		<div style={ { position: 'fixed', zIndex: 99 } }>
			<BodyPortal>
				<div className="console-shaped">geometry of its own</div>
			</BodyPortal>
		</div>
	);

	expect( container.querySelector( '.console-shaped' ) ).toBeNull();
	const host = document.body
		.querySelector( '.console-shaped' )
		.closest( '.newspack-nodes-skin-root' );
	expect( host.parentElement ).toBe( document.body );
	expect( host.className ).toBe(
		'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
	);
	expect( host.style.display ).toBe( 'contents' );
} );

// @longform A caller's own box is routinely a stacking context — a dashboard
// shell is `position: fixed; z-index: 99` — and a z-index inside one can only
// rank against its siblings there. A modal that must cover a `@wordpress/
// components` dialog portalled to the body at 100000 therefore cannot win from
// inside the tree, however high it raises its backdrop.
test( 'escapes the caller stacking context by rendering into the body', () => {
	const { container } = render(
		<div style={ { position: 'fixed', zIndex: 99 } }>
			<Modal ariaLabel="x" onClose={ () => {} } backdropClassName="deep">
				<p>body</p>
			</Modal>
		</div>
	);

	expect( container.querySelector( '.deep' ) ).toBeNull();
	const backdrop = document.body.querySelector( '.deep' );
	expect( backdrop ).not.toBeNull();
	expect( backdrop.closest( '[style*="z-index"]' ) ).toBeNull();
} );

// The skin lives on ancestors, so a host outside the tree carries them itself:
// the tokens resolve at `<html>`, but the type and colour rules key off these.
test( 'the portal host carries the skin classes', () => {
	render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			<p>body</p>
		</Modal>
	);

	const host = document.body
		.querySelector( '.newspack-nodes-modal__backdrop' )
		.closest( '.newspack-nodes-skin-root' );
	expect( host ).not.toBeNull();
	expect( host.className ).toBe(
		'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
	);
	expect( host.style.display ).toBe( 'contents' );
} );

// The backdrop is where position and z-index live, so a dialog opened OVER
// another modal layer — the Ask brief over a `@wordpress/components` one —
// raises itself there rather than inside the box.
test( 'puts backdropClassName on the backdrop, not the dialog', () => {
	render(
		<Modal
			ariaLabel="x"
			onClose={ () => {} }
			className="on-the-box"
			backdropClassName="on-the-backdrop"
		>
			body
		</Modal>
	);
	const backdrop = document.body.querySelector(
		'.newspack-nodes-modal__backdrop'
	);
	expect( backdrop.className ).toContain( 'on-the-backdrop' );
	expect( backdrop.className ).not.toContain( 'on-the-box' );
	expect( screen.getByRole( 'dialog' ).className ).toContain( 'on-the-box' );
} );

// Enter in a text field submits the dialog's form natively, so a dialog with a
// default action wears its box as that form rather than wrapping one inside.
test( 'with onSubmit the dialog box is a noValidate form whose submit acts', () => {
	const onSubmit = jest.fn();
	render(
		<Modal ariaLabel="x" onClose={ () => {} } onSubmit={ onSubmit }>
			<input type="url" defaultValue="not a url" />
		</Modal>
	);

	const dialog = screen.getByRole( 'dialog' );
	expect( dialog.tagName ).toBe( 'FORM' );
	expect( dialog.noValidate ).toBe( true );
	expect( dialog.className ).toBe(
		'newspack-nodes-modal newspack-nodes-modal--medium'
	);
	// The return is false when the handler prevented the default.
	expect( fireEvent.submit( dialog ) ).toBe( false );
	expect( onSubmit ).toHaveBeenCalledTimes( 1 );
} );

test( 'without onSubmit the dialog box stays a div', () => {
	render(
		<Modal ariaLabel="x" onClose={ () => {} }>
			b
		</Modal>
	);

	expect( screen.getByRole( 'dialog' ).tagName ).toBe( 'DIV' );
} );

// React bubbles a submit through the portal to every form above it in the
// tree, so the dialog's own form is where it stops.
test( 'a submit stops at its own dialog', () => {
	const outer = jest.fn();
	const inner = jest.fn();
	render(
		<form onSubmit={ outer }>
			<Modal ariaLabel="x" onClose={ () => {} } onSubmit={ inner }>
				b
			</Modal>
		</form>
	);

	fireEvent.submit( screen.getByRole( 'dialog' ) );
	expect( inner ).toHaveBeenCalledTimes( 1 );
	expect( outer ).not.toHaveBeenCalled();
} );

test( 'a header title takes focus when a dialog hands it focus, outside the tab order', () => {
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader title="Ledger of Pier 9" onClose={ () => {} } />
		</Modal>
	);

	const title = screen.getByText( 'Ledger of Pier 9' );
	expect( title.getAttribute( 'tabindex' ) ).toBe( '-1' );
	title.focus();
	expect( title.ownerDocument.activeElement ).toBe( title );
} );

const renderConfirm = ( onYes, onNo ) =>
	render(
		<Confirm
			title="Discard the Pier 9 board?"
			body="The quay desk loses its edits."
			yes="Discard board"
			no="Keep the board"
			onYes={ onYes }
			onNo={ onNo }
		/>
	);

test( 'Confirm asks its question with the safe answer focused', () => {
	renderConfirm( jest.fn(), jest.fn() );

	const dialog = screen.getByRole( 'dialog', {
		name: 'Discard the Pier 9 board?',
	} );
	expect( dialog.textContent ).toContain( 'The quay desk loses its edits.' );
	const keep = screen.getByRole( 'button', { name: 'Keep the board' } );
	expect( keep.ownerDocument.activeElement ).toBe( keep );
	const discard = screen.getByRole( 'button', { name: 'Discard board' } );
	expect( discard.className ).toContain( 'is-danger' );
} );

test.each( [
	[ 'Discard board', 'yes' ],
	[ 'Keep the board', 'no' ],
] )( 'Confirm plays the exit on %s, then answers %s alone', ( name, which ) => {
	jest.useFakeTimers();
	const answers = { yes: jest.fn(), no: jest.fn() };
	renderConfirm( answers.yes, answers.no );
	const dialog = screen.getByRole( 'dialog' );

	fireEvent.click( screen.getByRole( 'button', { name } ) );
	expect( backdropOf( dialog ).className ).toContain( 'is-closing' );
	expect( answers[ which ] ).not.toHaveBeenCalled();

	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( answers[ which ] ).toHaveBeenCalledTimes( 1 );
	expect( answers[ 'yes' === which ? 'no' : 'yes' ] ).not.toHaveBeenCalled();
} );

test( 'Confirm keeps its first answer when a second button is pressed during the exit', () => {
	jest.useFakeTimers();
	const onYes = jest.fn();
	const onNo = jest.fn();
	renderConfirm( onYes, onNo );

	fireEvent.click( screen.getByRole( 'button', { name: 'Keep the board' } ) );
	fireEvent.click( screen.getByRole( 'button', { name: 'Discard board' } ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onNo ).toHaveBeenCalledTimes( 1 );
	expect( onYes ).not.toHaveBeenCalled();
} );

test( 'Confirm runs only the first close: Escape, then a yes during the exit, answers no', () => {
	jest.useFakeTimers();
	const onYes = jest.fn();
	const onNo = jest.fn();
	renderConfirm( onYes, onNo );

	fireEvent.keyDown( document, { key: 'Escape' } );
	fireEvent.click( screen.getByRole( 'button', { name: 'Discard board' } ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onNo ).toHaveBeenCalledTimes( 1 );
	expect( onYes ).not.toHaveBeenCalled();
} );

test( 'Confirm answers no on Escape, after the exit', () => {
	jest.useFakeTimers();
	const onYes = jest.fn();
	const onNo = jest.fn();
	renderConfirm( onYes, onNo );

	fireEvent.keyDown( document, { key: 'Escape' } );
	expect( onNo ).not.toHaveBeenCalled();
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onNo ).toHaveBeenCalledTimes( 1 );
	expect( onYes ).not.toHaveBeenCalled();
} );

test( 'size puts its modifier on the box, medium by default', () => {
	render(
		<>
			<Modal ariaLabel="plain-204" onClose={ () => {} }>
				b
			</Modal>
			<Modal ariaLabel="wide-204" onClose={ () => {} } size="large">
				b
			</Modal>
		</>
	);

	expect(
		screen.getByRole( 'dialog', { name: 'plain-204' } ).className
	).toBe( 'newspack-nodes-modal newspack-nodes-modal--medium' );
	expect( screen.getByRole( 'dialog', { name: 'wide-204' } ).className ).toBe(
		'newspack-nodes-modal newspack-nodes-modal--large'
	);
} );

test( 'role alertdialog reaches the box', () => {
	render(
		<Modal ariaLabel="refusal-318" onClose={ () => {} } role="alertdialog">
			b
		</Modal>
	);

	const box = screen.getByRole( 'alertdialog', { name: 'refusal-318' } );
	expect( box.className ).toContain( 'newspack-nodes-modal' );
	expect( box.getAttribute( 'aria-modal' ) ).toBe( 'true' );
	expect( screen.queryByRole( 'dialog' ) ).toBeNull();
} );

test( 'without onClose, Escape and an outside mousedown do nothing and the header draws no close', () => {
	jest.useFakeTimers();
	const errors = [];
	const onError = ( e ) => errors.push( e.error ?? e.message );
	window.addEventListener( 'error', onError );
	try {
		render(
			<Modal>
				<ModalHeader title="Crop the heron 427" />
				<p>body</p>
			</Modal>
		);
		const dialog = screen.getByRole( 'dialog', {
			name: 'Crop the heron 427',
		} );

		fireEvent.keyDown( document, { key: 'Escape' } );
		fireEvent.mouseDown( backdropOf( dialog ) );
		act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

		expect( errors ).toEqual( [] );
		expect( backdropOf( dialog ).className ).not.toContain( 'is-closing' );
		expect( screen.queryByRole( 'button' ) ).toBeNull();
	} finally {
		window.removeEventListener( 'error', onError );
	}
} );

test( 'the header close plays the exit before onClose', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	render(
		<Modal onClose={ onClose }>
			<ModalHeader title="Egret spoke 509" onClose={ onClose } />
		</Modal>
	);
	const dialog = screen.getByRole( 'dialog', { name: 'Egret spoke 509' } );

	fireEvent.click( screen.getByRole( 'button', { name: 'Close' } ) );
	expect( backdropOf( dialog ).className ).toContain( 'is-closing' );
	expect( onClose ).not.toHaveBeenCalled();

	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS - 1 ) );
	expect( onClose ).not.toHaveBeenCalled();
	act( () => jest.advanceTimersByTime( 1 ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'an exiting box is inert, and an open one is not', () => {
	jest.useFakeTimers();
	render(
		<Modal ariaLabel="inert-918" onClose={ () => {} }>
			<button type="button">inside 918</button>
		</Modal>
	);
	const box = screen.getByRole( 'dialog', { name: 'inert-918' } );
	expect( box.hasAttribute( 'inert' ) ).toBe( false );

	fireEvent.keyDown( document, { key: 'Escape' } );
	expect( box.getAttribute( 'inert' ) ).toBe( '' );
} );

test( 'handleRef close plays the same exit', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	const handle = { current: null };
	render(
		<Modal ariaLabel="handle-612" onClose={ onClose } handleRef={ handle }>
			b
		</Modal>
	);
	const dialog = screen.getByRole( 'dialog', { name: 'handle-612' } );

	act( () => handle.current.close() );
	expect( backdropOf( dialog ).className ).toContain( 'is-closing' );
	expect( onClose ).not.toHaveBeenCalled();

	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

/**
 * An outer dialog holding an inner one as a React child, as ObjectForm holds
 * its Select Object picker; the inner's close clears the flag that opens it.
 *
 * @param {Object}     props
 * @param {boolean}    props.initiallyOpen Whether the inner opens with the outer.
 * @param {() => void} props.onOuterClose  The outer's onClose.
 */
function Nested( { initiallyOpen, onOuterClose } ) {
	const [ open, setOpen ] = useState( initiallyOpen );
	return (
		<Modal ariaLabel="outer-733" onClose={ onOuterClose }>
			<button type="button" onClick={ () => setOpen( true ) }>
				open inner 733
			</button>
			{ open && (
				<Modal ariaLabel="inner-733" onClose={ () => setOpen( false ) }>
					<p>inner body</p>
				</Modal>
			) }
		</Modal>
	);
}

test( 'a nested dialog: Escape closes only the inner, and a mousedown inside the inner leaves the outer open', () => {
	jest.useFakeTimers();
	const outer = jest.fn();
	render( <Nested initiallyOpen={ false } onOuterClose={ outer } /> );
	fireEvent.click( screen.getByText( 'open inner 733' ) );

	fireEvent.mouseDown( screen.getByText( 'inner body' ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( screen.getByRole( 'dialog', { name: 'inner-733' } ) ).toBeTruthy();
	expect( outer ).not.toHaveBeenCalled();

	fireEvent.keyDown( document, { key: 'Escape' } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( screen.queryByRole( 'dialog', { name: 'inner-733' } ) ).toBeNull();
	expect( outer ).not.toHaveBeenCalled();

	fireEvent.keyDown( document, { key: 'Escape' } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( outer ).toHaveBeenCalledTimes( 1 );
} );

test( 'a dialog mounted open inside another in one render is the top: Escape closes only it', () => {
	jest.useFakeTimers();
	const outer = jest.fn();
	render( <Nested initiallyOpen onOuterClose={ outer } /> );

	fireEvent.keyDown( document, { key: 'Escape' } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( screen.queryByRole( 'dialog', { name: 'inner-733' } ) ).toBeNull();
	expect( outer ).not.toHaveBeenCalled();
} );

test( 'actions render between the title and the close', () => {
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader
				title="Window 845"
				onClose={ () => {} }
				actions={ <button type="button">Back 845</button> }
			/>
		</Modal>
	);

	const header = document.querySelector( '.newspack-nodes-modal__header' );
	const [ title, actions, close ] = Array.from( header.children );
	expect( title.textContent ).toBe( 'Window 845' );
	expect( actions.tagName ).toBe( 'DIV' );
	expect( actions.className ).toBe( 'newspack-nodes-modal__header-actions' );
	expect( actions.textContent ).toBe( 'Back 845' );
	expect( close.className ).toBe( 'newspack-nodes-modal__close' );
} );

test( 'compact puts its modifier on the header', () => {
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader title="Picker 958" onClose={ () => {} } compact />
		</Modal>
	);

	expect(
		document.querySelector( '.newspack-nodes-modal__header' ).className
	).toBe(
		'newspack-nodes-modal__header newspack-nodes-modal__header--compact'
	);
} );

test( "Confirm's header is compact", () => {
	render(
		<Confirm
			title="Drop the egret spoke?"
			yes="Drop"
			no="Keep"
			onYes={ () => {} }
			onNo={ () => {} }
		/>
	);

	expect(
		document
			.querySelector( '.newspack-nodes-modal__header' )
			.classList.contains( 'newspack-nodes-modal__header--compact' )
	).toBe( true );
} );

test( 'a header in a shell without ModalClose runs its own onClose at once', () => {
	const onClose = jest.fn();
	render(
		<ModalTitleId.Provider value="shell-title-1061">
			<ModalHeader title="Console 1061" onClose={ onClose } />
		</ModalTitleId.Provider>
	);

	fireEvent.click( screen.getByRole( 'button', { name: 'Close' } ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'a Modal without onClose draws no close button, whatever its header is handed', () => {
	render(
		<Modal ariaLabel="Lapwing ledger">
			<ModalHeader title="Lapwing ledger" onClose={ () => {} } />
		</Modal>
	);

	expect( screen.queryByRole( 'button', { name: 'Close' } ) ).toBeNull();
} );

test( 'a dismissible Modal draws its header close without a header onClose', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	render(
		<Modal onClose={ onClose }>
			<ModalHeader title="Avocet ledger" />
		</Modal>
	);

	fireEvent.click( screen.getByRole( 'button', { name: 'Close' } ) );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( "an ESC a child's capture handler prevented leaves the dialog open", () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	function Picker() {
		const ref = useRef( null );
		useEffect( () => {
			const el = ref.current;
			const take = ( e ) => 'Escape' === e.key && e.preventDefault();
			el.addEventListener( 'keydown', take, true );
			return () => el.removeEventListener( 'keydown', take, true );
		}, [] );
		return <input ref={ ref } aria-label="Sanderling search" />;
	}
	render(
		<Modal ariaLabel="Sanderling ask" onClose={ onClose }>
			<Picker />
		</Modal>
	);

	fireEvent.keyDown(
		screen.getByRole( 'textbox', { name: 'Sanderling search' } ),
		{ key: 'Escape' }
	);
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

	expect( onClose ).not.toHaveBeenCalled();
	expect(
		backdropOf( screen.getByRole( 'dialog' ) ).className
	).not.toContain( 'is-closing' );
} );

test( 'a mousedown in a popover portalled outside the box leaves the dialog open; the backdrop closes it', () => {
	jest.useFakeTimers();
	const onClose = jest.fn();
	const slot = document.createElement( 'div' );
	slot.className = 'popover-slot-stub';
	document.body.appendChild( slot );
	try {
		render(
			<Modal ariaLabel="Redshank menu" onClose={ onClose }>
				<p>menu owner</p>
			</Modal>
		);
		render( <button type="button">Redshank item</button>, {
			container: slot,
		} );

		fireEvent.mouseDown(
			screen.getByRole( 'button', { name: 'Redshank item' } )
		);
		fireEvent.mouseDown( document.body );
		act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
		expect( onClose ).not.toHaveBeenCalled();

		fireEvent.mouseDown( backdropOf( screen.getByRole( 'dialog' ) ) );
		act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
		expect( onClose ).toHaveBeenCalledTimes( 1 );
	} finally {
		slot.remove();
	}
} );

test( 'a dialog with a header moves focus to its title on open', () => {
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader title="Whimbrel ledger" onClose={ () => {} } />
			<button type="button">Whimbrel action</button>
		</Modal>
	);

	expect( document.activeElement ).toBe(
		screen.getByRole( 'heading', { name: 'Whimbrel ledger' } )
	);
} );

test( 'a field the caller focuses on open keeps focus', () => {
	function Form() {
		const ref = useRef( null );
		useEffect( () => ref.current.focus(), [] );
		return <input ref={ ref } aria-label="Knot name" />;
	}
	render(
		<Modal onClose={ () => {} }>
			<ModalHeader title="Knot form" onClose={ () => {} } />
			<Form />
		</Modal>
	);

	expect( document.activeElement ).toBe(
		screen.getByRole( 'textbox', { name: 'Knot name' } )
	);
} );

test( 'a header-less dialog moves focus to its box, out of the tab order', () => {
	render(
		<Modal ariaLabel="Stint remove" onClose={ () => {} }>
			<p>Remove the stint?</p>
		</Modal>
	);

	const dialog = screen.getByRole( 'dialog', { name: 'Stint remove' } );
	expect( document.activeElement ).toBe( dialog );
	expect( dialog.getAttribute( 'tabindex' ) ).toBe( '-1' );
} );

test( 'focus returns to the opener once a dialog that moved it closes', () => {
	render( <button type="button">Ruff opener</button> );
	const opener = screen.getByRole( 'button', { name: 'Ruff opener' } );
	opener.focus();
	const { unmount } = render(
		<Modal onClose={ () => {} }>
			<ModalHeader title="Ruff ledger" onClose={ () => {} } />
		</Modal>
	);
	expect( document.activeElement ).not.toBe( opener );

	unmount();

	expect( document.activeElement ).toBe( opener );
} );

test.each( [
	[ 'Shift+Tab', 'the last control', true, 'Godwit last' ],
	[ 'Tab', 'the first control, its close', false, 'Close' ],
] )(
	'%s from the focused title stays in the dialog, at %s',
	( key, where, shiftKey, target ) => {
		render(
			<Modal onClose={ () => {} }>
				<ModalHeader title="Godwit ledger" onClose={ () => {} } />
				<button type="button">Godwit first</button>
				<button type="button">Godwit last</button>
			</Modal>
		);
		const title = screen.getByRole( 'heading', { name: 'Godwit ledger' } );
		expect( document.activeElement ).toBe( title );

		expect( fireEvent.keyDown( title, { key: 'Tab', shiftKey } ) ).toBe(
			false
		);

		expect( document.activeElement ).toBe(
			screen.getByRole( 'button', { name: target } )
		);
	}
);

const LOCK = 'newspack-nodes-modal-open';
const locked = () => document.body.classList.contains( LOCK );

test( 'an open dialog locks the page scroll, and unlocks it on close', () => {
	const { unmount } = render(
		<Modal ariaLabel="Turnstone lock" onClose={ () => {} }>
			<p>locked page</p>
		</Modal>
	);
	expect( locked() ).toBe( true );

	unmount();

	expect( locked() ).toBe( false );
} );

test( 'a nested pair keeps the page locked until both have closed', () => {
	jest.useFakeTimers();
	const { unmount } = render(
		<Nested initiallyOpen onOuterClose={ () => {} } />
	);
	expect( locked() ).toBe( true );

	fireEvent.keyDown( document, { key: 'Escape' } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );
	expect( screen.queryByRole( 'dialog', { name: 'inner-733' } ) ).toBeNull();
	expect( locked() ).toBe( true );

	unmount();
	expect( locked() ).toBe( false );
} );

test( 'a dialog unmounted during its exit unlocks the page', () => {
	jest.useFakeTimers();
	const { unmount } = render(
		<Modal ariaLabel="Sanderling lock" onClose={ () => {} }>
			<p>exiting page</p>
		</Modal>
	);
	fireEvent.keyDown( document, { key: 'Escape' } );
	act( () => jest.advanceTimersByTime( MODAL_EXIT_MS / 2 ) );
	expect( locked() ).toBe( true );

	unmount();

	expect( locked() ).toBe( false );
} );

test( 'Tab in a popover portalled outside the box is left to the popover', () => {
	const slot = document.createElement( 'div' );
	document.body.appendChild( slot );
	try {
		render(
			<Modal onClose={ () => {} }>
				<ModalHeader title="Knot link" onClose={ () => {} } />
				<button type="button">Knot first</button>
			</Modal>
		);
		render( <input aria-label="Knot link URL" />, { container: slot } );
		const url = screen.getByRole( 'textbox', { name: 'Knot link URL' } );
		url.focus();

		expect( fireEvent.keyDown( url, { key: 'Tab' } ) ).toBe( true );
		expect( fireEvent.keyDown( url, { key: 'Tab', shiftKey: true } ) ).toBe(
			true
		);
		expect( document.activeElement ).toBe( url );
	} finally {
		slot.remove();
	}
} );

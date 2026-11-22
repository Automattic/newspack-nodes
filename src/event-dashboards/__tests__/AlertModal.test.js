import { render, fireEvent, act } from '@testing-library/react';
import { MODAL_EXIT_MS } from '@newspack-nodes/shared/hooks/useModalExit';
import AlertModal from '../AlertModal';

// Every close plays the shared exit; `exit()` lets it finish.
beforeEach( () => {
	jest.useFakeTimers();
} );

afterEach( () => {
	jest.useRealTimers();
} );

const exit = () => act( () => jest.advanceTimersByTime( MODAL_EXIT_MS ) );

describe( 'AlertModal', () => {
	it( 'AlertModal is an alertdialog in the body portal with a compact header', () => {
		const { container, getByRole } = render(
			<div className="nodes-station-stub">
				<AlertModal
					title="Whimbrel refused"
					message="boom"
					onClose={ jest.fn() }
				/>
			</div>
		);
		const dialog = getByRole( 'alertdialog', {
			name: 'Whimbrel refused',
		} );

		expect( container.contains( dialog ) ).toBe( false );
		const backdrop = dialog.parentElement;
		expect( backdrop.className ).toBe( 'newspack-nodes-modal__backdrop' );
		expect( backdrop.parentElement.className ).toBe(
			'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( backdrop.parentElement.parentElement ).toBe( document.body );
		expect( dialog.querySelector( ':scope > header' ).className ).toBe(
			'newspack-nodes-modal__header newspack-nodes-modal__header--compact'
		);
	} );

	it( 'focuses OK on mount and closes on Escape once the exit has played', () => {
		const onClose = jest.fn();
		const { getByRole } = render(
			<AlertModal
				title="Mutation failed"
				message="boom"
				onClose={ onClose }
			/>
		);

		expect( getByRole( 'button', { name: 'OK' } ) ).toBe(
			document.activeElement
		);
		fireEvent.keyDown( document, { key: 'Escape' } );
		expect( onClose ).not.toHaveBeenCalled();
		exit();
		expect( onClose ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'plays the exit on OK before it closes', () => {
		const onClose = jest.fn();
		const { getByRole } = render(
			<AlertModal title="Turnstone" message="m" onClose={ onClose } />
		);
		const dialog = getByRole( 'alertdialog' );

		fireEvent.click( getByRole( 'button', { name: 'OK' } ) );

		expect( dialog.parentElement.className ).toBe(
			'newspack-nodes-modal__backdrop is-closing'
		);
		expect( dialog.getAttribute( 'inert' ) ).toBe( '' );
		expect( onClose ).not.toHaveBeenCalled();
		exit();
		expect( onClose ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'returns focus to its opener on close', () => {
		const { getByText } = render(
			<button type="button">opener-611</button>
		);
		const opener = getByText( 'opener-611' );
		opener.focus();
		const { unmount } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);

		unmount();
		expect( document.activeElement ).toBe( opener );
	} );

	it( 'keeps Tab inside the dialog, wrapping from OK to its close', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);
		const ok = getByRole( 'button', { name: 'OK' } );

		expect( fireEvent.keyDown( ok, { key: 'Tab' } ) ).toBe( false );
		expect( document.activeElement ).toBe(
			getByRole( 'button', { name: 'Close' } )
		);
	} );

	it( 'renders the OK button with the canonical .button class, not a bespoke one', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);
		const ok = getByRole( 'button', { name: 'OK' } );
		expect( ok.classList.contains( 'button' ) ).toBe( true );
		expect( ok.classList.contains( 'nodes-tm__alert-ok' ) ).toBe( false );
	} );

	it( 'marks the alert as a canonical modal without becoming a theme provider', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);
		const dialog = getByRole( 'alertdialog' );

		expect( dialog.className ).toBe(
			'newspack-nodes-modal newspack-nodes-modal--medium nodes-tm__alert'
		);
		expect( dialog.classList.contains( 'newspack-nodes-theme' ) ).toBe(
			false
		);
	} );

	it( 'heads the alert with the shared header, and closes on its icon', () => {
		const onClose = jest.fn();
		const { getByRole } = render(
			<AlertModal
				title="Egret fleet refused"
				message="boom"
				onClose={ onClose }
			/>
		);
		const header = getByRole( 'alertdialog' ).querySelector(
			':scope > header.newspack-nodes-modal__header'
		);

		const title = header.querySelector( 'h2.newspack-nodes-modal__title' );
		expect( title.textContent ).toBe( 'Egret fleet refused' );
		expect(
			getByRole( 'alertdialog', { name: 'Egret fleet refused' } )
		).toBe( header.parentElement );
		expect( header.parentElement.hasAttribute( 'aria-label' ) ).toBe(
			false
		);
		fireEvent.click( header.querySelector( 'button[aria-label="Close"]' ) );
		exit();
		expect( onClose ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'lays its OK out in the shared actions row alone', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);

		expect(
			getByRole( 'button', { name: 'OK' } ).parentElement.className
		).toBe( 'newspack-nodes-modal__actions' );
	} );

	it( 'closes on backdrop mouse down', () => {
		const onClose = jest.fn();
		render(
			<AlertModal
				title="Mutation failed"
				message="boom"
				onClose={ onClose }
			/>
		);

		fireEvent.mouseDown(
			document.querySelector( '.newspack-nodes-modal__backdrop' )
		);
		exit();
		expect( onClose ).toHaveBeenCalledTimes( 1 );
	} );
} );

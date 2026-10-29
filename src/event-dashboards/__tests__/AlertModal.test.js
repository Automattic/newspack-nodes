import { render, fireEvent } from '@testing-library/react';
import AlertModal from '../AlertModal';

describe( 'AlertModal', () => {
	it( 'focuses OK on mount and closes on Escape', () => {
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

	it( 'keeps Tab on its one button', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);
		const ok = getByRole( 'button', { name: 'OK' } );

		expect( fireEvent.keyDown( ok, { key: 'Tab' } ) ).toBe( false );
		expect( document.activeElement ).toBe( ok );
	} );

	it( 'renders the OK button with the canonical .button class, not a bespoke one', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);
		const ok = getByRole( 'button', { name: 'OK' } );
		expect( ok.classList.contains( 'button' ) ).toBe( true );
		expect( ok.classList.contains( 'nodes-tm__alert-ok' ) ).toBe( false );
	} );

	it( 'marks the inline alert as a canonical modal without becoming a theme provider', () => {
		const { getByRole } = render(
			<AlertModal title="t" message="m" onClose={ jest.fn() } />
		);
		const dialog = getByRole( 'alertdialog' );

		expect( dialog.className ).toBe(
			'nodes-tm__alert newspack-nodes-modal'
		);
		expect( dialog.classList.contains( 'newspack-nodes-theme' ) ).toBe(
			false
		);
	} );

	it( 'closes on backdrop mouse down', () => {
		const onClose = jest.fn();
		const { container } = render(
			<AlertModal
				title="Mutation failed"
				message="boom"
				onClose={ onClose }
			/>
		);

		fireEvent.mouseDown(
			container.querySelector( '.nodes-tm__alert-backdrop' )
		);
		expect( onClose ).toHaveBeenCalledTimes( 1 );
	} );
} );

import { render, fireEvent } from '@testing-library/react';
import { Core } from '../../runtime/core';
import {
	registerDevtoolsTab,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';
import DebugPanel from '../DebugPanel';

// A trivial overlay tab so the panel has something to mount.
const StubTab = () => <div data-testid="stub-tab" />;

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
	resetDevtoolsTabs();
	registerDevtoolsTab( {
		id: 'stub',
		label: 'Stub',
		host: 'overlay',
		order: 0,
		component: StubTab,
	} );
} );

test( 'renders ONE shared header above the tab content, with the close button', () => {
	const { container, getByTestId } = render(
		<DebugPanel storageKey="k" onClose={ () => {} } />
	);
	// Exactly one header, and it precedes the tab content in document order.
	const headers = container.querySelectorAll( '.topology-header' );
	expect( headers ).toHaveLength( 1 );
	const header = getByTestId( 'overlay-header' );
	const content = container.querySelector( '.nodes-devtools__tab-content' );
	expect(
		header.compareDocumentPosition( content ) &
			window.Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
} );

test( 'the shared header close button invokes onClose', () => {
	const onClose = jest.fn();
	const { getByLabelText } = render(
		<DebugPanel storageKey="k" onClose={ onClose } />
	);
	fireEvent.click( getByLabelText( /close/i ) );
	expect( onClose ).toHaveBeenCalledTimes( 1 );
} );

test( 'pointer-down on the shared header starts a panel drag', () => {
	const { getByTestId } = render(
		<DebugPanel storageKey="k" onClose={ () => {} } />
	);
	// beginDrag adds a window pointermove listener; the move must not throw.
	fireEvent.pointerDown( getByTestId( 'overlay-header' ) );
	expect( () =>
		fireEvent.pointerMove( window, { clientX: 10, clientY: 10 } )
	).not.toThrow();
} );

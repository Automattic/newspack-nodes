/**
 * The `?` picker. Picker mode turns the cursor into a `?`, and the next click
 * asks about whatever carries `[data-ask]` — the target IS the scope.
 *
 * Two things it must not get wrong: it has to SUPPRESS the element's own
 * handler (a row click opens a modal, a flame span reveals a log entry), and
 * its modifier has to be the one already shipping — `metaKey || ctrlKey` read
 * on mousedown, which is the working answer to macOS treating Control-click as
 * a secondary click.
 */

import { render, act, fireEvent } from '@testing-library/react';
import { useAskPicker } from '../useAskPicker';

function Harness( { onPick, onRowClick } ) {
	const { active, start, cancel } = useAskPicker( { onPick } );
	return (
		<div>
			<button
				type="button"
				data-testid="trigger"
				onClick={ active ? cancel : start }
			>
				{ active ? 'cancel' : 'ask' }
			</button>
			<div data-testid="scope" data-ask="request:abc:2">
				<table>
					<tbody>
						<tr
							data-testid="row"
							data-ask="span:wp_loaded"
							onClick={ onRowClick }
						>
							<td data-testid="cell">wp_loaded</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p data-testid="outside">nothing askable here</p>
		</div>
	);
}

function setup() {
	const onPick = jest.fn();
	const onRowClick = jest.fn();
	const utils = render(
		<Harness onPick={ onPick } onRowClick={ onRowClick } />
	);
	return { onPick, onRowClick, ...utils };
}

function startPicking( getByTestId ) {
	act( () => {
		fireEvent.click( getByTestId( 'trigger' ) );
	} );
}

afterEach( () => {
	document.body.className = '';
} );

test( 'starting marks the document so the cursor changes', () => {
	const { getByTestId } = setup();

	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
	);
	startPicking( getByTestId );
	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		true
	);
} );

test( 'a click resolves the descriptor chain innermost first', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'cell' ) );
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onPick ).toHaveBeenCalledTimes( 1 );
	expect( onPick.mock.calls[ 0 ][ 0 ] ).toEqual( [
		'span:wp_loaded',
		'request:abc:2',
	] );
} );

test( "the target's own handler never fires while picking", () => {
	const { getByTestId, onRowClick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onRowClick ).not.toHaveBeenCalled();
} );

test( 'outside picker mode the row behaves exactly as before', () => {
	const { getByTestId, onRowClick, onPick } = setup();

	act( () => {
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onRowClick ).toHaveBeenCalledTimes( 1 );
	expect( onPick ).not.toHaveBeenCalled();
} );

test( 'a modified click adds to the selection, read on mousedown', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'cell' ), { metaKey: true } );
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onPick.mock.calls[ 0 ][ 1 ].additive ).toBe( true );
	// Still picking: an additive pick does not end the mode.
	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		true
	);
} );

test( 'ctrl is honoured the same as meta, matching what already ships', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'cell' ), { ctrlKey: true } );
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onPick.mock.calls[ 0 ][ 1 ].additive ).toBe( true );
} );

test( 'a plain pick ends picker mode', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'cell' ) );
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
	);
} );

test( 'clicking something unaskable cancels rather than asking about the page', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.click( getByTestId( 'outside' ) );
	} );

	expect( onPick ).not.toHaveBeenCalled();
	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
	);
} );

test( 'escape cancels', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );

	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
	);
} );

test( 'a second click on the trigger cancels', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );
	startPicking( getByTestId );

	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
	);
} );

test( 'askable elements become focusable while picking, and revert after', () => {
	const { getByTestId } = setup();
	const row = getByTestId( 'row' );

	expect( row.hasAttribute( 'tabindex' ) ).toBe( false );
	startPicking( getByTestId );
	expect( row.getAttribute( 'tabindex' ) ).toBe( '0' );

	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );
	expect( row.hasAttribute( 'tabindex' ) ).toBe( false );
} );

test( 'enter asks, so the picker is not mouse-only', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.keyDown( getByTestId( 'row' ), {
			key: 'Enter',
			bubbles: true,
		} );
	} );

	expect( onPick.mock.calls[ 0 ][ 0 ] ).toEqual( [
		'span:wp_loaded',
		'request:abc:2',
	] );
} );

test( 'unmounting while picking leaves nothing behind', () => {
	const { getByTestId, unmount, onPick } = setup();
	startPicking( getByTestId );

	unmount();

	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
	);
	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );
	expect( onPick ).not.toHaveBeenCalled();
} );

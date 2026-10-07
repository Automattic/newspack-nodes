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
import { ASK_PICKED_ATTR, useAskPicker } from '../useAskPicker';

function Harness( {
	onPick,
	onUnpick,
	onAbandon,
	onRowClick,
	otherAsk = 'span:init',
} ) {
	const { active, start, cancel } = useAskPicker( {
		onPick,
		onUnpick,
		onAbandon,
	} );
	return (
		<div>
			<button
				type="button"
				data-testid="trigger"
				data-ask-trigger=""
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
						<tr data-testid="other" data-ask={ otherAsk }>
							<td data-testid="other-cell">init</td>
						</tr>
						<tr
							data-testid="own-tab"
							data-ask="url:own-tab"
							tabIndex={ -1 }
						>
							<td>a row that sets its own tabIndex</td>
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
	const onUnpick = jest.fn();
	const onAbandon = jest.fn();
	const onRowClick = jest.fn();
	const utils = render(
		<Harness
			onPick={ onPick }
			onUnpick={ onUnpick }
			onAbandon={ onAbandon }
			onRowClick={ onRowClick }
		/>
	);
	return { onPick, onUnpick, onAbandon, onRowClick, ...utils };
}

function startPicking( getByTestId ) {
	act( () => {
		fireEvent.click( getByTestId( 'trigger' ) );
	} );
}

afterEach( () => {
	document.documentElement.classList.remove( 'newspack-nodes-asking' );
} );

// The ROOT carries the mark, not the body: Chrome repaints the cursor from the
// document when the node under the pointer is replaced, and a root left at
// `auto` drops the `?` back to an arrow mid-pick.
test( 'starting marks the document so the cursor changes', () => {
	const { getByTestId } = setup();

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( false );
	startPicking( getByTestId );
	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( true );
	expect( document.body.classList.contains( 'newspack-nodes-asking' ) ).toBe(
		false
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
	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( true );
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

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( false );
} );

test( 'clicking something unaskable never asks about the page', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.click( getByTestId( 'outside' ) );
	} );

	expect( onPick ).not.toHaveBeenCalled();
} );

/**
 * A missed click used to disarm silently, which reads as the picker being
 * broken and hands the next click to the element underneath — on a flame graph
 * that zooms. Staying armed lets the second click land, and the `?` cursor is
 * what says the picker is still on.
 */
test( 'a missed click leaves the picker armed', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.click( getByTestId( 'outside' ) );
	} );

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( true );
} );

// The cursor IS the picker's state. A re-render that dropped the root class
// would take the `?` away while the picker was still armed.
test( 'the cursor survives a re-render while armed', () => {
	const { getByTestId, rerender, onPick } = setup();
	startPicking( getByTestId );

	rerender( <Harness onPick={ onPick } onRowClick={ jest.fn() } /> );

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( true );
} );

test( 'escape cancels', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( false );
} );

test( 'a second click on the trigger cancels', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );
	startPicking( getByTestId );

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( false );
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

	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( false );
	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );
	expect( onPick ).not.toHaveBeenCalled();
} );

/**
 * Giving up is not the same as finishing: a multi-select that ends in Escape
 * meant none of it, while the plain click that ends one means all of it.
 */
test( 'escape reports the selection as abandoned', () => {
	const { getByTestId, onAbandon } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );

	expect( onAbandon ).toHaveBeenCalledTimes( 1 );
} );

test( 'a plain pick finishes rather than abandons', () => {
	const { getByTestId, onAbandon } = setup();
	startPicking( getByTestId );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'cell' ) );
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onAbandon ).not.toHaveBeenCalled();
} );

// A press the picker owns, as the browser delivers it: cancelable, so a
// prevented default reads back as `false` from dispatchEvent.
function press( el, init = {} ) {
	let kept;
	act( () => {
		kept = el.dispatchEvent(
			new window.MouseEvent( 'mousedown', {
				bubbles: true,
				cancelable: true,
				...init,
			} )
		);
	} );
	return kept;
}

function cmdClick( el ) {
	press( el, { metaKey: true } );
	act( () => {
		fireEvent.click( el, { metaKey: true } );
	} );
}

const picked = ( el ) => el.hasAttribute( ASK_PICKED_ATTR );

/**
 * Firefox selects and outlines table cells on an accel-press; the picker's
 * own gesture is that press, so its default has to go while armed.
 */
test( 'an armed picker cancels the default of a modified press', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	expect( press( getByTestId( 'cell' ), { metaKey: true } ) ).toBe( false );
	expect( press( getByTestId( 'cell' ), { ctrlKey: true } ) ).toBe( false );
} );

test( 'an armed picker leaves a plain press alone, so a drag still selects', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	expect( press( getByTestId( 'cell' ) ) ).toBe( true );
} );

test( 'a disarmed picker leaves a modified press to the surface under it', () => {
	const { getByTestId } = setup();

	expect( press( getByTestId( 'cell' ), { metaKey: true } ) ).toBe( true );
} );

test( 'a modified click marks the target it picked, and no other', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	cmdClick( getByTestId( 'cell' ) );

	expect( picked( getByTestId( 'row' ) ) ).toBe( true );
	expect( picked( getByTestId( 'scope' ) ) ).toBe( false );
	expect( picked( getByTestId( 'other' ) ) ).toBe( false );
} );

test( 'a second modified click on a pick takes it back out', () => {
	const { getByTestId, onPick, onUnpick } = setup();
	startPicking( getByTestId );

	cmdClick( getByTestId( 'cell' ) );
	cmdClick( getByTestId( 'cell' ) );

	expect( picked( getByTestId( 'row' ) ) ).toBe( false );
	expect( onPick ).toHaveBeenCalledTimes( 1 );
	expect( onUnpick ).toHaveBeenCalledTimes( 1 );
	expect( onUnpick.mock.calls[ 0 ][ 0 ] ).toEqual( [
		'span:wp_loaded',
		'request:abc:2',
	] );
	// Taking one back is still selecting: the picker stays armed.
	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( true );
} );

test( 'picks accumulate, each marked on its own', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );

	cmdClick( getByTestId( 'cell' ) );
	cmdClick( getByTestId( 'other-cell' ) );

	expect( picked( getByTestId( 'row' ) ) ).toBe( true );
	expect( picked( getByTestId( 'other' ) ) ).toBe( true );
	expect( onPick.mock.calls.map( ( [ chain ] ) => chain[ 0 ] ) ).toEqual( [
		'span:wp_loaded',
		'span:init',
	] );
} );

// The mark names a descriptor: a surface that re-renders a row onto another
// entry must not leave the paint on the row it used to be.
test( 'the mark follows the descriptor when a row is re-rendered', async () => {
	const { getByTestId, rerender, onPick } = setup();
	startPicking( getByTestId );
	cmdClick( getByTestId( 'other-cell' ) );

	rerender( <Harness onPick={ onPick } otherAsk="span:shutdown" /> );
	await act( async () => {} );
	expect( picked( getByTestId( 'other' ) ) ).toBe( false );

	rerender( <Harness onPick={ onPick } otherAsk="span:init" /> );
	await act( async () => {} );
	expect( picked( getByTestId( 'other' ) ) ).toBe( true );
} );

test( 'a plain click on a pick finishes without asking about it twice', () => {
	const { getByTestId, onPick, onUnpick } = setup();
	startPicking( getByTestId );
	cmdClick( getByTestId( 'cell' ) );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'cell' ) );
		fireEvent.click( getByTestId( 'cell' ) );
	} );

	expect( onPick ).toHaveBeenCalledTimes( 1 );
	expect( onUnpick ).not.toHaveBeenCalled();
	expect(
		document.documentElement.classList.contains( 'newspack-nodes-asking' )
	).toBe( false );
} );

test( 'finishing the pick clears every mark', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );
	cmdClick( getByTestId( 'cell' ) );

	act( () => {
		fireEvent.mouseDown( getByTestId( 'other-cell' ) );
		fireEvent.click( getByTestId( 'other-cell' ) );
	} );

	expect( picked( getByTestId( 'row' ) ) ).toBe( false );
	expect( picked( getByTestId( 'other' ) ) ).toBe( false );
} );

test( 'escape clears every mark, and the next session starts empty', () => {
	const { getByTestId, onPick } = setup();
	startPicking( getByTestId );
	cmdClick( getByTestId( 'cell' ) );

	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );
	expect( picked( getByTestId( 'row' ) ) ).toBe( false );

	// The old pick is gone: the same element picks afresh rather than toggling.
	startPicking( getByTestId );
	cmdClick( getByTestId( 'cell' ) );
	expect( onPick ).toHaveBeenCalledTimes( 2 );
	expect( picked( getByTestId( 'row' ) ) ).toBe( true );
} );

// UrlTable and UrlDetailView rows set their own tabIndex; React never puts
// back what the picker takes away, so the picker takes away only its own.
test( "an element's own tabindex survives a pick session", () => {
	const { getByTestId } = setup();
	const own = getByTestId( 'own-tab' );

	startPicking( getByTestId );
	expect( own.getAttribute( 'tabindex' ) ).toBe( '-1' );
	act( () => {
		fireEvent.keyDown( document, { key: 'Escape' } );
	} );

	expect( own.getAttribute( 'tabindex' ) ).toBe( '-1' );
	expect( getByTestId( 'row' ).hasAttribute( 'tabindex' ) ).toBe( false );
} );

// A cancelled press moves no focus, so the Ask button would keep it and the
// next Enter would land there and cancel the selection.
test( 'a modified press focuses the askable it lands on', () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );
	getByTestId( 'trigger' ).focus();

	press( getByTestId( 'cell' ), { metaKey: true } );

	expect( document.activeElement ).toBe( getByTestId( 'row' ) );
} );

// @longform While armed every DOM change reaches the observer — a tooltip, an
// auto-refresh, a search unfolding rows — so one outside every askable must
// cost no scan of the page and no write.
test( 'a mutation outside any askable writes nothing', async () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );
	const writes = [ 'setAttribute', 'removeAttribute', 'toggleAttribute' ].map(
		( method ) => jest.spyOn( window.Element.prototype, method )
	);
	const scans = jest.spyOn( document, 'querySelectorAll' );

	const note = document.createElement( 'span' );
	note.textContent = 'tooltip 791ms';
	getByTestId( 'outside' ).appendChild( note );
	await act( async () => {} );

	for ( const spy of [ ...writes, scans ] ) {
		expect( spy ).not.toHaveBeenCalled();
		spy.mockRestore();
	}
} );

test( 'an askable rendered after arming becomes focusable', async () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );

	const late = document.createElement( 'div' );
	late.innerHTML = '<p data-ask="span:late-render-5">late</p>';
	getByTestId( 'outside' ).appendChild( late );
	await act( async () => {} );

	expect( late.firstChild.getAttribute( 'tabindex' ) ).toBe( '0' );
	late.remove();
} );

test( 'an askable rendered after arming wears a mark it was picked under', async () => {
	const { getByTestId } = setup();
	startPicking( getByTestId );
	cmdClick( getByTestId( 'other-cell' ) );

	const again = document.createElement( 'p' );
	again.setAttribute( 'data-ask', 'span:init' );
	getByTestId( 'outside' ).appendChild( again );
	await act( async () => {} );

	expect( picked( again ) ).toBe( true );
	again.remove();
} );

// A span name is free text: a quote or a backslash must not break the
// selector that finds the elements a toggle repaints.
test( 'a descriptor holding a quote and a backslash toggles its mark', () => {
	const { getByTestId } = setup();
	const odd = document.createElement( 'p' );
	odd.setAttribute( 'data-ask', 'span:the "main" C:\\loop' );
	getByTestId( 'outside' ).appendChild( odd );
	startPicking( getByTestId );

	cmdClick( odd );
	expect( picked( odd ) ).toBe( true );
	cmdClick( odd );
	expect( picked( odd ) ).toBe( false );
	odd.remove();
} );

/**
 * ReplFooter tests — input/submit, Ctrl+L clear, toggles, shortcuts, height persistence.
 */

import { render, fireEvent, act } from '@testing-library/react';
import ReplFooter from '../ReplFooter';

const baseProps = {
	topology: 'demo',
	partition: 0,
	streamStatus: 'open',
	canSend: true,
	onSubmit: () => {},
	onClear: () => {},
	transcript: [],
	expanded: false,
	onExpandedChange: () => {},
};

const findInput = ( container ) =>
	container.querySelector( '.topology-repl__input' );

describe( 'ReplFooter', () => {
	beforeEach( () => {
		window.localStorage.clear();
	} );

	it( 'renders the prompt with topology + partition', () => {
		const { container } = render( <ReplFooter { ...baseProps } /> );
		const prompt = container.querySelector( '.topology-repl__prompt' );
		expect( prompt.textContent ).toMatch( /demo\.p0/ );
	} );

	it( 'maps streamStatus to CONNECTING/CONNECTED/DISCONNECTED/CLOSED', () => {
		const cases = [
			[ 'connecting', /CONNECTING/ ],
			[ 'open', /CONNECTED/ ],
			[ 'error', /DISCONNECTED/ ],
			[ 'closed', /CLOSED/ ],
		];
		for ( const [ status, regex ] of cases ) {
			const { container, unmount } = render(
				<ReplFooter { ...baseProps } streamStatus={ status } />
			);
			expect( container.textContent ).toMatch( regex );
			unmount();
		}
	} );

	it( 'uppercases unknown statuses verbatim', () => {
		const { container } = render(
			<ReplFooter { ...baseProps } streamStatus="weird" />
		);
		expect( container.textContent ).toMatch( /WEIRD/ );
	} );

	it( 'disables input when canSend=false', () => {
		const { container } = render(
			<ReplFooter { ...baseProps } canSend={ false } />
		);
		expect( findInput( container ).disabled ).toBe( true );
	} );

	it( 'submits trimmed input on Enter', () => {
		const onSubmit = jest.fn();
		const onExpandedChange = jest.fn();
		const { container } = render(
			<ReplFooter
				{ ...baseProps }
				onSubmit={ onSubmit }
				onExpandedChange={ onExpandedChange }
			/>
		);
		const input = findInput( container );
		fireEvent.change( input, { target: { value: '  ls  ' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onSubmit ).toHaveBeenCalledWith( 'ls' );
		expect( onExpandedChange ).toHaveBeenCalledWith( true );
	} );

	it( 'no-ops Enter on empty input', () => {
		const onSubmit = jest.fn();
		const { container } = render(
			<ReplFooter { ...baseProps } onSubmit={ onSubmit } />
		);
		fireEvent.keyDown( findInput( container ), { key: 'Enter' } );
		expect( onSubmit ).not.toHaveBeenCalled();
	} );

	it( 'Ctrl+L invokes onClear without submitting', () => {
		const onSubmit = jest.fn();
		const onClear = jest.fn();
		const { container } = render(
			<ReplFooter
				{ ...baseProps }
				onSubmit={ onSubmit }
				onClear={ onClear }
			/>
		);
		fireEvent.keyDown( findInput( container ), {
			key: 'l',
			ctrlKey: true,
		} );
		expect( onClear ).toHaveBeenCalled();
		expect( onSubmit ).not.toHaveBeenCalled();
	} );

	it( 'focusing the input expands the transcript', () => {
		const onExpandedChange = jest.fn();
		const { container } = render(
			<ReplFooter
				{ ...baseProps }
				onExpandedChange={ onExpandedChange }
			/>
		);
		fireEvent.focus( findInput( container ) );
		expect( onExpandedChange ).toHaveBeenCalledWith( true );
	} );

	it( 'renders the ▲ restore button only when not expanded', () => {
		const { container, rerender } = render(
			<ReplFooter { ...baseProps } expanded={ false } />
		);
		expect( container.textContent ).toMatch( /▲/ );
		rerender( <ReplFooter { ...baseProps } expanded /> );
		// ▼ minimize button appears in the transcript; ▲ goes away.
		expect( container.textContent ).toMatch( /▼/ );
	} );

	it( 'clicking ▲ restore expands', () => {
		const onExpandedChange = jest.fn();
		const { container } = render(
			<ReplFooter
				{ ...baseProps }
				onExpandedChange={ onExpandedChange }
			/>
		);
		fireEvent.click( container.querySelector( '.topology-repl__toggle' ) );
		expect( onExpandedChange ).toHaveBeenCalledWith( true );
	} );

	it( 'clicking ▼ minimize collapses when expanded', () => {
		const onExpandedChange = jest.fn();
		const { container } = render(
			<ReplFooter
				{ ...baseProps }
				expanded
				onExpandedChange={ onExpandedChange }
			/>
		);
		const minimize = container.querySelector( '.topology-repl__toggle' );
		fireEvent.click( minimize );
		expect( onExpandedChange ).toHaveBeenCalledWith( false );
	} );

	it( 'clicking the ✕ clear-and-minimize fires onClear then collapses', () => {
		const onClear = jest.fn();
		const onExpandedChange = jest.fn();
		const { container } = render(
			<ReplFooter
				{ ...baseProps }
				expanded
				onClear={ onClear }
				onExpandedChange={ onExpandedChange }
			/>
		);
		fireEvent.click( container.querySelector( '.topology-repl__clear' ) );
		expect( onClear ).toHaveBeenCalled();
		expect( onExpandedChange ).toHaveBeenCalledWith( false );
	} );

	it( 'renders transcript entries with sent vs recv prefixes', () => {
		const transcript = [
			{ key: 1, kind: 'sent', text: 'ls' },
			{ key: 2, kind: 'recv', text: 'response line' },
		];
		const { container } = render(
			<ReplFooter { ...baseProps } expanded transcript={ transcript } />
		);
		const entries = container.querySelectorAll( '.topology-repl__entry' );
		expect( entries[ 0 ].textContent ).toBe( 'demo.p0> ls' );
		expect( entries[ 1 ].textContent ).toBe( 'response line' );
	} );

	it( 'Escape on document collapses when expanded', () => {
		const onExpandedChange = jest.fn();
		render(
			<ReplFooter
				{ ...baseProps }
				expanded
				onExpandedChange={ onExpandedChange }
			/>
		);
		fireEvent.keyDown( document, { key: 'Escape' } );
		expect( onExpandedChange ).toHaveBeenCalledWith( false );
	} );

	it( '`/` from non-editable target focuses input + expands', () => {
		const onExpandedChange = jest.fn();
		render(
			<ReplFooter
				{ ...baseProps }
				onExpandedChange={ onExpandedChange }
			/>
		);
		const div = document.createElement( 'div' );
		document.body.appendChild( div );
		div.focus();
		fireEvent.keyDown( div, { key: '/' } );
		expect( onExpandedChange ).toHaveBeenCalledWith( true );
	} );

	it( '`/` while typing in an input is ignored', () => {
		const onExpandedChange = jest.fn();
		render(
			<ReplFooter
				{ ...baseProps }
				onExpandedChange={ onExpandedChange }
			/>
		);
		const otherInput = document.createElement( 'input' );
		document.body.appendChild( otherInput );
		otherInput.focus();
		fireEvent.keyDown( otherInput, { key: '/' } );
		expect( onExpandedChange ).not.toHaveBeenCalled();
	} );

	it( 'persists transcript-pane height to localStorage on change', async () => {
		const { container } = render(
			<ReplFooter { ...baseProps } expanded />
		);
		// Initial render writes the default height.
		await act( async () => {} );
		expect(
			window.localStorage.getItem(
				'newspack-nodes:topology-console:repl-height'
			)
		).not.toBeNull();
		// Drag the resize handle: pageY decreases as the operator drags up.
		const handle = container.querySelector(
			'.topology-repl__resize-handle'
		);
		fireEvent.mouseDown( handle, { clientY: 500 } );
		fireEvent.mouseMove( document, { clientY: 400 } );
		fireEvent.mouseUp( document );
		await act( async () => {} );
		const stored = window.localStorage.getItem(
			'newspack-nodes:topology-console:repl-height'
		);
		expect( Number( stored ) ).toBeGreaterThan( 0 );
	} );

	it( 'restores a stored height on next mount', async () => {
		window.localStorage.setItem(
			'newspack-nodes:topology-console:repl-height',
			'250'
		);
		const { container } = render(
			<ReplFooter { ...baseProps } expanded />
		);
		const transcript = container.querySelector(
			'.topology-repl__transcript'
		);
		expect( transcript.style.height ).toBe( '250px' );
	} );

	it( 'transcript click does not re-focus when there is an active text selection', () => {
		const transcript = [ { key: 1, kind: 'recv', text: 'output' } ];
		const { container } = render(
			<ReplFooter { ...baseProps } expanded transcript={ transcript } />
		);
		const input = findInput( container );
		input.blur();
		// Mock getSelection to return a non-empty selection.
		const origGet = window.getSelection;
		window.getSelection = () => ( { toString: () => 'selected' } );
		const tx = container.querySelector( '.topology-repl__transcript' );
		fireEvent.click( tx );
		expect( document.activeElement ).not.toBe( input );
		window.getSelection = origGet;
	} );
} );

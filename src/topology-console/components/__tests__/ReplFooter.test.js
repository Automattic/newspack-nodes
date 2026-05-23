/**
 * ReplFooter tests — input/submit, Ctrl+L clear, toggles, shortcuts, height persistence.
 */

import { render, fireEvent, act } from '@testing-library/react';
import ReplFooter from '../ReplFooter';

const baseProps = {
	prompt: '/_http/demo.p0',
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

	it( 'renders the cwd prompt it is given', () => {
		const { container } = render( <ReplFooter { ...baseProps } /> );
		const prompt = container.querySelector( '.topology-repl__prompt' );
		expect( prompt.textContent ).toMatch( /\/_http\/demo\.p0>/ );
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

	it( 'shows no example commands in the prompt placeholder', () => {
		const { container } = render( <ReplFooter { ...baseProps } /> );
		expect( findInput( container ).placeholder ).toBe( '' );
	} );

	it( 'keeps the connecting placeholder when canSend=false', () => {
		const { container } = render(
			<ReplFooter { ...baseProps } canSend={ false } />
		);
		expect( findInput( container ).placeholder ).toBe( 'Connecting…' );
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
		expect( entries[ 0 ].textContent ).toBe( '/_http/demo.p0> ls' );
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

	describe( 'tab completion', () => {
		// Render once, then push a new `completion` prop to simulate the async
		// reply arriving after Tab fired the query.
		const renderWithCompletion = ( extra = {} ) => {
			const onComplete = jest.fn();
			const utils = render(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ null }
					{ ...extra }
				/>
			);
			return { onComplete, ...utils };
		};

		it( 'Tab fires onComplete with the current input and prevents default', () => {
			const { container, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'conn' } } );
			// fireEvent returns false when the handler called preventDefault.
			const notPrevented = fireEvent.keyDown( input, { key: 'Tab' } );
			expect( onComplete ).toHaveBeenCalledWith( 'conn' );
			expect( notPrevented ).toBe( false );
		} );

		it( 'a single matching candidate completes the token fully with a trailing space', () => {
			const { container, rerender, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'dump_n' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ {
						candidates: [ 'dump_node', 'dump_metadata' ],
						seq: 1,
					} }
				/>
			);
			// readline appends a space after a unique completion so the next token starts clean.
			expect( findInput( container ).value ).toBe( 'dump_node ' );
		} );

		it( 'Tab on an already-complete unique token appends the trailing space', () => {
			const { container, rerender, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'uptime' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ { candidates: [ 'uptime' ], seq: 1 } }
				/>
			);
			expect( findInput( container ).value ).toBe( 'uptime ' );
		} );

		it( 'multiple matches with a common prefix extend the token to the LCP', () => {
			const { container, rerender, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'co' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ {
						candidates: [ 'connect', 'connect_node', 'echo' ],
						seq: 1,
					} }
				/>
			);
			// 'co' filters to connect*/connect_node; LCP is 'connect'.
			expect( findInput( container ).value ).toBe( 'connect' );
		} );

		it( 'extends only the trailing token, preserving the leading command', () => {
			const { container, rerender, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'dump_node ec' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ {
						candidates: [ 'echo1', 'echo2' ],
						seq: 1,
					} }
				/>
			);
			expect( findInput( container ).value ).toBe( 'dump_node echo' );
		} );

		it( 'extends on the first Tab then lists on the second when still ambiguous', () => {
			const onShowCandidates = jest.fn();
			const { container, rerender, onComplete } = renderWithCompletion( {
				onShowCandidates,
			} );
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'dum' } } );
			// First Tab extends 'dum' → 'dump' (the common prefix); no list yet.
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ {
						candidates: [ 'dump', 'dump_node', 'dump_metadata' ],
						seq: 1,
					} }
				/>
			);
			expect( findInput( container ).value ).toBe( 'dump' );
			expect( onShowCandidates ).not.toHaveBeenCalled();
			// Second consecutive Tab on 'dump' (still ambiguous) lists — two presses
			// total, even though the first one extended.
			fireEvent.keyDown( findInput( container ), { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ {
						candidates: [ 'dump', 'dump_node', 'dump_metadata' ],
						seq: 2,
					} }
				/>
			);
			expect( onShowCandidates ).toHaveBeenCalledWith( [
				'dump',
				'dump_node',
				'dump_metadata',
			] );
		} );

		it( 'requires two Tab presses to list candidates when the LCP cannot extend (readline)', () => {
			const onShowCandidates = jest.fn();
			const { container, rerender, onComplete } = renderWithCompletion( {
				onShowCandidates,
			} );
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'connect' } } );
			// First Tab on an ambiguous token: silent (no extension, no list).
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ {
						candidates: [ 'connect', 'connect_node' ],
						seq: 1,
					} }
				/>
			);
			expect( onShowCandidates ).not.toHaveBeenCalled();
			expect( findInput( container ).value ).toBe( 'connect' );
			// Second consecutive Tab on the same ambiguous token → list the options.
			fireEvent.keyDown( findInput( container ), { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ {
						candidates: [ 'connect', 'connect_node' ],
						seq: 2,
					} }
				/>
			);
			expect( onShowCandidates ).toHaveBeenCalledWith( [
				'connect',
				'connect_node',
			] );
			expect( findInput( container ).value ).toBe( 'connect' );
		} );

		it( 'typing between Tabs resets the two-press count', () => {
			const onShowCandidates = jest.fn();
			const { container, rerender, onComplete } = renderWithCompletion( {
				onShowCandidates,
			} );
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'connect' } } );
			fireEvent.keyDown( input, { key: 'Tab' } ); // first press: armed
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ {
						candidates: [ 'connect', 'connect_node' ],
						seq: 1,
					} }
				/>
			);
			// User edits the line (type then delete back to the same token); the
			// next Tab must behave as a fresh first press.
			fireEvent.change( findInput( container ), {
				target: { value: 'connectx' },
			} );
			fireEvent.change( findInput( container ), {
				target: { value: 'connect' },
			} );
			fireEvent.keyDown( findInput( container ), { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ {
						candidates: [ 'connect', 'connect_node' ],
						seq: 2,
					} }
				/>
			);
			expect( onShowCandidates ).not.toHaveBeenCalled();
		} );

		it( 'does not apply a stale reply when the input no longer ends with the token', () => {
			const { container, rerender, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'co' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			// User keeps typing before the reply lands; input no longer ends with 'co'.
			fireEvent.change( input, { target: { value: 'connect_node x' } } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ {
						candidates: [ 'connect', 'connect_node' ],
						seq: 1,
					} }
				/>
			);
			expect( findInput( container ).value ).toBe( 'connect_node x' );
		} );

		it( 'does nothing when no candidate matches the token', () => {
			const onShowCandidates = jest.fn();
			const { container, rerender, onComplete } = renderWithCompletion( {
				onShowCandidates,
			} );
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'zzz' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					onShowCandidates={ onShowCandidates }
					completion={ { candidates: [ 'echo', 'ping' ], seq: 1 } }
				/>
			);
			expect( findInput( container ).value ).toBe( 'zzz' );
			expect( onShowCandidates ).not.toHaveBeenCalled();
		} );

		it( 'completes an empty trailing token (after a space) to the LCP', () => {
			const { container, rerender, onComplete } = renderWithCompletion();
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'dump_node ' } } );
			fireEvent.keyDown( input, { key: 'Tab' } );
			rerender(
				<ReplFooter
					{ ...baseProps }
					onComplete={ onComplete }
					completion={ {
						candidates: [ 'echo1', 'echo2' ],
						seq: 1,
					} }
				/>
			);
			// Empty token matches all; LCP 'echo' extends past ''.
			expect( findInput( container ).value ).toBe( 'dump_node echo' );
		} );

		it( 'Tab is a no-op when no onComplete is supplied', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			fireEvent.change( input, { target: { value: 'x' } } );
			expect( () =>
				fireEvent.keyDown( input, { key: 'Tab' } )
			).not.toThrow();
		} );
	} );

	describe( 'command history', () => {
		const submit = ( input, line ) => {
			fireEvent.change( input, { target: { value: line } } );
			fireEvent.keyDown( input, { key: 'Enter' } );
		};

		it( 'Up recalls the previous submitted command', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'b' );
		} );

		it( 'repeated Up walks further back through history', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'a' );
		} );

		it( 'Up clamps at the oldest entry', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'a' );
		} );

		it( 'Down walks toward newer entries', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			fireEvent.keyDown( input, { key: 'ArrowDown' } );
			expect( input.value ).toBe( 'b' );
		} );

		it( 'Down past the newest restores the in-progress draft', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'b' );
			// Type a draft, then navigate history and come back.
			fireEvent.change( input, { target: { value: 'draft' } } );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'b' );
			fireEvent.keyDown( input, { key: 'ArrowDown' } );
			expect( input.value ).toBe( 'draft' );
		} );

		it( 'does not record empty submits', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			// Empty submit (whitespace-only) should be ignored.
			fireEvent.change( input, { target: { value: '   ' } } );
			fireEvent.keyDown( input, { key: 'Enter' } );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'a' );
		} );

		it( 'collapses an immediate duplicate of the most-recent entry', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'a' );
			submit( input, 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			// Only one 'a' recorded; this is the oldest.
			expect( input.value ).toBe( 'a' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'a' );
		} );

		it( 'submitting resets the history cursor and clears the draft', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			submit( input, 'b' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			// Submit the recalled line; cursor should reset past-the-end.
			fireEvent.keyDown( input, { key: 'Enter' } );
			expect( input.value ).toBe( '' );
			fireEvent.keyDown( input, { key: 'ArrowUp' } );
			expect( input.value ).toBe( 'b' );
		} );

		it( 'does not hijack arrows when the event target is not the prompt', () => {
			const { container } = render( <ReplFooter { ...baseProps } /> );
			const input = findInput( container );
			submit( input, 'a' );
			const other = document.createElement( 'input' );
			document.body.appendChild( other );
			fireEvent.keyDown( other, { key: 'ArrowUp' } );
			// The prompt input value is untouched.
			expect( input.value ).toBe( '' );
			document.body.removeChild( other );
		} );
	} );
} );

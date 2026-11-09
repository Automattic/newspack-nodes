/* eslint-env jest */
/**
 * A slot renders the editor a context registered, with the slot's props, and
 * nothing until the editor's bundle has registered one.
 */

import { act, render, screen } from '@testing-library/react';
import CompositionEditSlot from '../CompositionEditSlot';
import { registerCompositionEditor } from '../editorRegistry';

afterEach( () => {
	delete window.__newspackNodesCompositionEditors;
} );

const PierEditor = ( { heading, onDone } ) => (
	<button type="button" data-testid="pier-editor" onClick={ onDone }>
		{ heading }
	</button>
);

describe( 'CompositionEditSlot', () => {
	it( 'renders nothing until a registration arrives, then the editor with its props', () => {
		const onDone = jest.fn();
		const { container } = render(
			<CompositionEditSlot
				context="acme-desk/board"
				heading="Edit the pier board"
				onDone={ onDone }
			/>
		);
		expect( container.innerHTML ).toBe( '' );

		act( () => {
			registerCompositionEditor( 'acme-desk/board', PierEditor );
		} );
		const editor = screen.getByTestId( 'pier-editor' );
		expect( editor.textContent ).toBe( 'Edit the pier board' );
		editor.click();
		expect( onDone ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'renders only its own context’s editor', () => {
		registerCompositionEditor( 'acme-desk/digest', PierEditor );
		const { container } = render(
			<CompositionEditSlot context="acme-desk/board" heading="Board" />
		);
		expect( container.innerHTML ).toBe( '' );
	} );
} );

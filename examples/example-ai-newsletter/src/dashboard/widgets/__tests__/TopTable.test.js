/* eslint-env jest */
/**
 * TopTable widget — reads ONLY the `top-table:view` node's slice via useNodeState
 * and renders the score-ranked table (with inline score bars) plus the
 * client-side newsletter actions: draft preview, copy-markdown, create-draft-post.
 * The draft actions operate on the `top` items, so they live in THIS widget.
 *
 * The "Create draft post" action is exercised through the injected `createDraft`
 * prop seam (never the real network).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { Core } from '@newspack-nodes/runtime';
import { TopTableViewNode } from '../../nodes/top-table-view-node';
import { TopTable } from '../TopTable';

const top = [
	{ source: 'releases', title: 'Big release', score: 9.5 },
	{ source: 'community', title: 'Hot thread', score: 4 },
];

beforeEach( () => Core.reset() );

function mountView( slice ) {
	const node = new TopTableViewNode();
	node.name = 'top-table:view';
	if ( slice ) {
		node.setState( 'view', slice );
	}
	return node;
}

describe( 'TopTable', () => {
	it( 'renders each top item with a rank and a score bar sized by score', () => {
		mountView( { top } );
		const { container } = render( <TopTable /> );
		expect( screen.getByText( 'Big release' ) ).toBeInTheDocument();
		expect( screen.getByText( 'Hot thread' ) ).toBeInTheDocument();
		expect( screen.getByText( '#1' ) ).toBeInTheDocument();
		expect( screen.getByText( '#2' ) ).toBeInTheDocument();
		const bars = container.querySelectorAll( '.eai-insights__score-bar' );
		expect( bars.length ).toBe( 2 );
		// Top item (max score) fills 100%.
		expect( bars[ 0 ].style.width ).toBe( '100%' );
	} );

	it( 're-renders when its view node publishes a new slice', () => {
		const node = mountView( { top: [] } );
		render( <TopTable /> );
		act( () => node.setState( 'view', { top } ) );
		expect( screen.getByText( 'Big release' ) ).toBeInTheDocument();
	} );

	it( 'shows an empty state (no table) until items arrive', () => {
		mountView( { top: [] } );
		render( <TopTable /> );
		expect( screen.queryByRole( 'table' ) ).not.toBeInTheDocument();
		expect(
			screen.queryByRole( 'button', { name: /draft newsletter/i } )
		).not.toBeInTheDocument();
		expect(
			screen.getByText( /no scored items yet/i )
		).toBeInTheDocument();
	} );

	it( 'reveals a rendered preview (not a textarea) when "Draft newsletter" is clicked', async () => {
		mountView( { top } );
		render( <TopTable /> );
		fireEvent.click(
			screen.getByRole( 'button', { name: /draft newsletter/i } )
		);
		expect( screen.queryByRole( 'textbox' ) ).not.toBeInTheDocument();
		const preview = await screen.findByTestId( 'eai-insights-preview' );
		expect( preview.textContent ).toContain( 'Big release' );
		expect( preview.textContent ).toContain( 'Hot thread' );
	} );

	it( 'copies the markdown to the clipboard when "Copy markdown" is clicked', async () => {
		const writeText = jest.fn( () => Promise.resolve() );
		Object.assign( window.navigator, { clipboard: { writeText } } );
		mountView( { top } );
		render( <TopTable /> );
		fireEvent.click(
			screen.getByRole( 'button', { name: /copy markdown/i } )
		);
		expect( writeText ).toHaveBeenCalledTimes( 1 );
		const copied = writeText.mock.calls[ 0 ][ 0 ];
		expect( copied ).toContain( '# ' );
		expect( copied ).toContain( 'Big release' );
		expect( await screen.findByText( /copied/i ) ).toBeInTheDocument();
	} );

	it( 'does not crash or show "Copied" when the clipboard API is unavailable', async () => {
		const original = window.navigator.clipboard;
		Object.assign( window.navigator, { clipboard: undefined } );
		mountView( { top } );
		render( <TopTable /> );
		expect( () =>
			fireEvent.click(
				screen.getByRole( 'button', { name: /copy markdown/i } )
			)
		).not.toThrow();
		expect( screen.queryByText( /copied/i ) ).not.toBeInTheDocument();
		Object.assign( window.navigator, { clipboard: original } );
	} );

	it( 'creates a draft post and shows an "Edit draft" link on success', async () => {
		const createDraft = jest.fn( () => Promise.resolve( { id: 42 } ) );
		mountView( { top } );
		render( <TopTable createDraft={ createDraft } /> );
		fireEvent.click(
			screen.getByRole( 'button', { name: /create draft post/i } )
		);
		await waitFor( () => expect( createDraft ).toHaveBeenCalledTimes( 1 ) );
		const arg = createDraft.mock.calls[ 0 ][ 0 ];
		expect( arg.title.length ).toBeGreaterThan( 0 );
		expect( arg.content ).toContain( '<strong>Big release</strong>' );
		const link = await screen.findByRole( 'link', { name: /edit draft/i } );
		expect( link.getAttribute( 'href' ) ).toContain( 'post=42' );
		expect( link.getAttribute( 'href' ) ).toContain( 'action=edit' );
	} );

	it( 'shows an inline error notice when creating a draft post fails', async () => {
		const createDraft = jest.fn( () =>
			Promise.reject( new Error( 'rest blew up' ) )
		);
		mountView( { top } );
		render( <TopTable createDraft={ createDraft } /> );
		fireEvent.click(
			screen.getByRole( 'button', { name: /create draft post/i } )
		);
		await waitFor( () => expect( createDraft ).toHaveBeenCalledTimes( 1 ) );
		expect(
			await screen.findByText( /rest blew up/i )
		).toBeInTheDocument();
		expect(
			screen.queryByRole( 'link', { name: /edit draft/i } )
		).not.toBeInTheDocument();
	} );

	it( 'shows an error (not a dead post=undefined link) when the draft reply has no id', async () => {
		const createDraft = jest.fn( () => Promise.resolve( {} ) );
		mountView( { top } );
		render( <TopTable createDraft={ createDraft } /> );
		fireEvent.click(
			screen.getByRole( 'button', { name: /create draft post/i } )
		);
		await waitFor( () => expect( createDraft ).toHaveBeenCalledTimes( 1 ) );
		expect( await screen.findByRole( 'alert' ) ).toBeInTheDocument();
		expect(
			screen.queryByRole( 'link', { name: /edit draft/i } )
		).not.toBeInTheDocument();
	} );

	it( 'surfaces a slice error as a notice', () => {
		mountView( { top: [], error: 'top read failed' } );
		render( <TopTable /> );
		expect( screen.getByRole( 'alert' ).textContent ).toMatch(
			/top read failed/
		);
	} );
} );

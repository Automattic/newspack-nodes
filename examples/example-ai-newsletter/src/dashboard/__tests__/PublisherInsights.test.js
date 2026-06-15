/* eslint-env jest */
/**
 * PublisherInsights — the thin view over the `insights:view` model. It mounts
 * the graph (useInsightsGraph) and reads the model via useNodeState. Here we
 * inject a fake CommandClient whose `insights` reply carries a known model, so
 * the mounted graph fills the view and the component renders the live analytics
 * dashboard (KPI stats, proportion bars, ranked table, draft actions).
 *
 * The "Create draft post" action is exercised through the injected `createDraft`
 * prop seam (never the real network).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	newMessage,
	TO,
	FROM,
	ID,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	Core,
} from '@newspack-nodes/runtime';

jest.mock( '@newspack-nodes/shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

import PublisherInsights from '../PublisherInsights';

const model = {
	sources: { releases: 2, community: 1 },
	top: [
		{ source: 'releases', title: 'Big release', score: 9.5 },
		{ source: 'community', title: 'Hot thread', score: 4 },
	],
	accumulated: 3,
};

function makeClient( replyType, payload ) {
	return {
		buildMessage( { to, verb, args = '' } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ VALUE ] = { name: verb, arguments: args, to };
			return m;
		},
		postBatch( messages ) {
			return Promise.resolve(
				messages.map( ( m ) => {
					const reply = newMessage();
					reply[ TYPE ] = replyType;
					reply[ TO ] = m[ FROM ];
					reply[ ID ] = m[ ID ];
					reply[ VALUE ] = { name: m[ VALUE ]?.name, payload };
					return reply;
				} )
			);
		},
	};
}

function clientReturning( jsonModel ) {
	return makeClient( TM_COMMAND | TM_RESPONSE, jsonModel );
}

function clientFailing( errorText ) {
	return makeClient( TM_COMMAND | TM_RESPONSE | TM_ERROR, errorText );
}

// Render the populated dashboard and wait until the live data has arrived.
async function renderPopulated( props = {} ) {
	render(
		<PublisherInsights
			refreshMs={ 4000 }
			commandClient={ clientReturning( JSON.stringify( model ) ) }
			{ ...props }
		/>
	);
	await waitFor( () =>
		expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
	);
}

beforeEach( () => Core.reset() );

describe( 'PublisherInsights', () => {
	it( 'renders the per-source counts, the score-ranked table, and the accumulated count', async () => {
		await renderPopulated();
		expect( screen.getByText( 'Hot thread' ) ).toBeInTheDocument();
		expect(
			screen.getByText( /Accumulated items: 3/ )
		).toBeInTheDocument();
		expect( screen.getByRole( 'table' ) ).toBeInTheDocument();
	} );

	it( 'shows KPI stat cards: total items, top score, and source count', async () => {
		const { container } = render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientReturning( JSON.stringify( model ) ) }
			/>
		);
		await waitFor( () =>
			expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
		);
		// Total items = accumulated (3); Top score = max score (9.5); Sources = 2.
		expect( screen.getByText( /total items/i ) ).toBeInTheDocument();
		expect( screen.getByText( /top score/i ) ).toBeInTheDocument();
		expect( screen.getByText( /^sources$/i ) ).toBeInTheDocument();
		// Read each card's number by its sibling label, so the score-bar value in
		// the table can't satisfy the assertion.
		const nums = [
			...container.querySelectorAll( '.eai-insights__stat' ),
		].map(
			( card ) =>
				card.querySelector( '.eai-insights__stat-num' ).textContent
		);
		expect( nums ).toEqual( [ '3', '9.5', '2' ] );
	} );

	it( 'renders each top item with a rank and a score bar sized by score', async () => {
		const { container } = render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientReturning( JSON.stringify( model ) ) }
			/>
		);
		await waitFor( () =>
			expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
		);
		// Rank cells.
		expect( screen.getByText( '#1' ) ).toBeInTheDocument();
		expect( screen.getByText( '#2' ) ).toBeInTheDocument();
		// At least one score bar with an inline width style; the top item (max
		// score) fills 100%.
		const bars = container.querySelectorAll( '.eai-insights__score-bar' );
		expect( bars.length ).toBe( 2 );
		expect( bars[ 0 ].style.width ).toBe( '100%' );
	} );

	it( 'renders each source as a proportion bar with an inline width style', async () => {
		const { container } = render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientReturning( JSON.stringify( model ) ) }
			/>
		);
		await waitFor( () =>
			expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
		);
		const bars = container.querySelectorAll( '.eai-insights__bar-fill' );
		expect( bars.length ).toBe( 2 );
		// releases = 2 of 3 total → ~66.66%.
		expect( bars[ 0 ].style.width ).toContain( '66.6' );
	} );

	it( 'reveals a rendered preview (not a textarea) when "Draft newsletter" is clicked', async () => {
		await renderPopulated();
		fireEvent.click(
			screen.getByRole( 'button', { name: /draft newsletter/i } )
		);
		// A preview list of items, NOT a raw-markdown textarea.
		expect( screen.queryByRole( 'textbox' ) ).not.toBeInTheDocument();
		const preview = await screen.findByTestId( 'eai-insights-preview' );
		expect( preview.textContent ).toContain( 'Big release' );
		expect( preview.textContent ).toContain( 'Hot thread' );
	} );

	it( 'copies the markdown to the clipboard when "Copy markdown" is clicked', async () => {
		const writeText = jest.fn( () => Promise.resolve() );
		Object.assign( window.navigator, { clipboard: { writeText } } );
		await renderPopulated();
		fireEvent.click(
			screen.getByRole( 'button', { name: /copy markdown/i } )
		);
		expect( writeText ).toHaveBeenCalledTimes( 1 );
		const copied = writeText.mock.calls[ 0 ][ 0 ];
		expect( copied ).toContain( '# ' );
		expect( copied ).toContain( 'Big release' );
		// The transient "Copied" affordance appears.
		expect( await screen.findByText( /copied/i ) ).toBeInTheDocument();
	} );

	it( 'creates a draft post and shows an "Edit draft" link on success', async () => {
		const createDraft = jest.fn( () => Promise.resolve( { id: 42 } ) );
		await renderPopulated( { createDraft } );
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
		await renderPopulated( { createDraft } );
		fireEvent.click(
			screen.getByRole( 'button', { name: /create draft post/i } )
		);
		await waitFor( () => expect( createDraft ).toHaveBeenCalledTimes( 1 ) );
		const notice = await screen.findByText( /rest blew up/i );
		expect( notice ).toBeInTheDocument();
		expect(
			screen.queryByRole( 'link', { name: /edit draft/i } )
		).not.toBeInTheDocument();
	} );

	it( 'does not crash or show "Copied" when the clipboard API is unavailable', async () => {
		const original = window.navigator.clipboard;
		// Simulate an insecure context / older browser: no clipboard API.
		Object.assign( window.navigator, { clipboard: undefined } );
		await renderPopulated();
		expect( () =>
			fireEvent.click(
				screen.getByRole( 'button', { name: /copy markdown/i } )
			)
		).not.toThrow();
		expect( screen.queryByText( /copied/i ) ).not.toBeInTheDocument();
		Object.assign( window.navigator, { clipboard: original } );
	} );

	it( 'shows an error (not a dead post=undefined link) when the draft reply has no id', async () => {
		const createDraft = jest.fn( () => Promise.resolve( {} ) );
		await renderPopulated( { createDraft } );
		fireEvent.click(
			screen.getByRole( 'button', { name: /create draft post/i } )
		);
		await waitFor( () => expect( createDraft ).toHaveBeenCalledTimes( 1 ) );
		expect( await screen.findByRole( 'alert' ) ).toBeInTheDocument();
		expect(
			screen.queryByRole( 'link', { name: /edit draft/i } )
		).not.toBeInTheDocument();
	} );

	it( 'shows an empty state (no table) until the pipeline has produced items', async () => {
		render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientReturning(
					JSON.stringify( {
						sources: {},
						top: [],
						accumulated: 0,
					} )
				) }
			/>
		);
		await waitFor( () =>
			expect(
				screen.getByText( /no scored items yet/i )
			).toBeInTheDocument()
		);
		expect( screen.queryByRole( 'table' ) ).not.toBeInTheDocument();
		expect(
			screen.queryByRole( 'button', { name: /draft newsletter/i } )
		).not.toBeInTheDocument();
	} );

	it( 'surfaces a failed poll as an error notice', async () => {
		render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientFailing( 'snapshot read failed' ) }
			/>
		);
		await waitFor( () =>
			expect( screen.getByRole( 'alert' ) ).toBeInTheDocument()
		);
		expect( screen.getByRole( 'alert' ).textContent ).toMatch(
			/snapshot read failed/
		);
	} );
} );

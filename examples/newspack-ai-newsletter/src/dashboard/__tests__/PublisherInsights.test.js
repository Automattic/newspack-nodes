/* eslint-env jest */
/**
 * PublisherInsights — the thin view over the `insights:view` model. It mounts
 * the graph (useInsightsGraph) and reads the model via useNodeState. Here we
 * inject a fake CommandClient whose `insights` reply carries a known model, so
 * the mounted graph fills the view and the component renders the live data.
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

beforeEach( () => Core.reset() );

describe( 'PublisherInsights', () => {
	it( 'renders the per-source counts, the score-ranked table, and the accumulated count', async () => {
		render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientReturning( JSON.stringify( model ) ) }
			/>
		);
		await waitFor( () =>
			expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
		);
		expect( screen.getByText( 'Hot thread' ) ).toBeInTheDocument();
		// Accumulated count, by its label (not a bare /3/ that any value could match).
		expect(
			screen.getByText( /Accumulated items: 3/ )
		).toBeInTheDocument();
		// A table with the items.
		expect( screen.getByRole( 'table' ) ).toBeInTheDocument();
	} );

	it( 'renders a markdown draft into a textarea when "Draft newsletter" is clicked', async () => {
		render(
			<PublisherInsights
				refreshMs={ 4000 }
				commandClient={ clientReturning( JSON.stringify( model ) ) }
			/>
		);
		await waitFor( () =>
			expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
		);
		fireEvent.click(
			screen.getByRole( 'button', { name: /draft newsletter/i } )
		);
		const textarea = screen.getByRole( 'textbox' );
		expect( textarea.value ).toContain( 'Big release' );
		expect( textarea.value ).toContain( '# ' );
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

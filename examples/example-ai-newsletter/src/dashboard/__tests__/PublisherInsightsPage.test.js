/* eslint-env jest */
/**
 * PublisherInsightsPage — mounts the genuine node graph (usePublisherInsightsGraph)
 * and renders the three slice widgets. Here we inject a fake CommandClient whose
 * slice replies (counts/top/accumulated) carry known data, so the graph fills the
 * three view nodes and the page renders the populated dashboard.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import {
	newMessage,
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	Core,
} from '@newspack-nodes/runtime';
import PublisherInsightsPage from '../PublisherInsightsPage';

const ROUTER = '_router';

// A fake CommandClient: postBatch echoes a per-verb reply pivoted back along FROM.
function makeClient( payloadByVerb ) {
	return {
		postBatch( messages ) {
			return Promise.resolve(
				messages.map( ( m ) => {
					const reply = newMessage();
					reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
					reply[ TO ] = m[ FROM ];
					reply[ ID ] = m[ ID ];
					reply[ VALUE ] = {
						name: m[ VALUE ]?.name,
						payload: payloadByVerb[ m[ VALUE ]?.name ] ?? null,
					};
					return reply;
				} )
			);
		},
	};
}

const populated = {
	counts: JSON.stringify( { sources: { releases: 2, community: 1 } } ),
	top: JSON.stringify( {
		top: [
			{ source: 'releases', title: 'Big release', score: 9.5 },
			{ source: 'community', title: 'Hot thread', score: 4 },
		],
	} ),
	accumulated: JSON.stringify( { accumulated: 3 } ),
};

beforeEach( () => Core.reset() );

// Render the page, drive one router tick to fill the views, await the replies.
async function renderAndTick( client ) {
	const utils = render( <PublisherInsightsPage commandClient={ client } /> );
	await act( async () => {
		Core.node( ROUTER ).fireCb();
	} );
	return utils;
}

// Source names appearing in the SourceCounts proportion bars (`releases` also
// appears in the TopTable Source column, so scope to the bar labels).
function sourceBarNames( container ) {
	return [
		...container.querySelectorAll( '.eai-insights__source-name' ),
	].map( ( el ) => el.textContent );
}

describe( 'PublisherInsightsPage', () => {
	it( 'renders the Publisher Insights heading', async () => {
		// useBatchedPoll fires one batched poll on mount (immediate first paint),
		// so the mount settles async view-node updates — flush them under act().
		await act( async () => {
			render(
				<PublisherInsightsPage
					commandClient={ makeClient( populated ) }
				/>
			);
		} );
		expect(
			screen.getByRole( 'heading', { name: 'Publisher Insights' } )
		).toBeInTheDocument();
	} );

	it( 'renders all three slice widgets from their own view nodes after a tick', async () => {
		const { container } = await renderAndTick( makeClient( populated ) );
		await waitFor( () =>
			expect( screen.getByText( 'Big release' ) ).toBeInTheDocument()
		);
		// counts slice → SourceCounts (scoped to the bar labels).
		expect( sourceBarNames( container ) ).toEqual( [
			'releases',
			'community',
		] );
		// top slice → TopTable.
		expect( screen.getByText( 'Hot thread' ) ).toBeInTheDocument();
		expect( screen.getByRole( 'table' ) ).toBeInTheDocument();
		// accumulated slice → AccumulatedCard.
		expect( screen.getByText( /total items/i ) ).toBeInTheDocument();
		expect(
			container.querySelector( '.eai-insights__stat-num' ).textContent
		).toBe( '3' );
	} );

	it( 'renders per-slice empty states from an empty SERVER reply (after a tick)', async () => {
		// Drive the real reply path (renderAndTick), not the constructor seed —
		// this proves an empty server reply lands in the views and renders empty.
		await renderAndTick(
			makeClient( {
				counts: JSON.stringify( { sources: {} } ),
				top: JSON.stringify( { top: [] } ),
				accumulated: JSON.stringify( { accumulated: 0 } ),
			} )
		);
		await waitFor( () =>
			expect(
				screen.getByText( /no scored items yet/i )
			).toBeInTheDocument()
		);
		expect( screen.queryByRole( 'table' ) ).not.toBeInTheDocument();
	} );
} );

/* eslint-env jest */
/**
 * PublisherInsightsPage — mounts the genuine node graph (usePublisherInsightsGraph)
 * and renders the three slice widgets. Here we seam at the wire, whose
 * slice replies (counts/top/accumulated) carry known data, so the graph fills the
 * three view nodes and the page renders the populated dashboard.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { act } from 'react';
import { VALUE, Core } from '@newspack-nodes/runtime';
import PublisherInsightsPage from '../PublisherInsightsPage';

const ROUTER = '_router';

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

// The seam is the wire; the page's graph POSTs and unpacks for real.
function installWire( payloadByVerb = {} ) {
	return installFakeCommandWire(
		( m ) => payloadByVerb[ m[ VALUE ]?.name ] ?? null
	);
}

beforeEach( () => Core.reset() );

// Render the page, drive one router tick to fill the views, await the replies.
async function renderAndTick() {
	const utils = render( <PublisherInsightsPage /> );
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
			render( <PublisherInsightsPage /> );
		} );
		expect(
			screen.getByRole( 'heading', { name: 'Publisher Insights' } )
		).toBeInTheDocument();
	} );

	it( 'renders all three slice widgets from their own view nodes after a tick', async () => {
		installWire( populated );
		const { container } = await renderAndTick();
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
		installWire( {
			counts: JSON.stringify( { sources: {} } ),
			top: JSON.stringify( { top: [] } ),
			accumulated: JSON.stringify( { accumulated: 0 } ),
		} );
		await renderAndTick();
		await waitFor( () =>
			expect(
				screen.getByText( /no scored items yet/i )
			).toBeInTheDocument()
		);
		expect( screen.queryByRole( 'table' ) ).not.toBeInTheDocument();
	} );

	it( 'mounts the debug overlay so the live graph is inspectable in the console', async () => {
		// The overlay is self-gated by isDebugEnabled — enable it via the sticky
		// localStorage flag so it mounts, then assert its FAB renders on the page.
		window.localStorage.setItem( 'newspack-nodes:debug', '1' );
		await act( async () => {
			render( <PublisherInsightsPage /> );
		} );
		expect(
			screen.getByRole( 'button', { name: 'Toggle node debugger' } )
		).toBeInTheDocument();
		window.localStorage.removeItem( 'newspack-nodes:debug' );
	} );
} );

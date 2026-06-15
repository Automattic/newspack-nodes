/* eslint-env jest */
import { render, screen } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';

// Page-hidden so the mounted graph's poll interval never starts in this smoke
// test; the one immediate mount-poll uses a default CommandClient whose fetch
// rejects in jsdom and is swallowed (rate-limited) — no network, no crash.
jest.mock( '@newspack-nodes/shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => false,
} ) );

import PublisherInsightsPage from '../PublisherInsightsPage';

beforeEach( () => Core.reset() );

describe( 'PublisherInsightsPage', () => {
	it( 'renders the Publisher Insights heading', () => {
		render( <PublisherInsightsPage /> );
		expect(
			screen.getByRole( 'heading', { name: 'Publisher Insights' } )
		).toBeInTheDocument();
	} );

	it( 'shows the empty state (no table) until the poll fills it', () => {
		render( <PublisherInsightsPage /> );
		expect(
			screen.getByText( /no scored items yet/i )
		).toBeInTheDocument();
		expect( screen.queryByRole( 'table' ) ).not.toBeInTheDocument();
	} );
} );

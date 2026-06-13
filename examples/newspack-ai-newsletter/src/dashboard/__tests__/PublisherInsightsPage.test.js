/* eslint-env jest */
import { render, screen } from '@testing-library/react';
import PublisherInsightsPage from '../PublisherInsightsPage';

describe( 'PublisherInsightsPage', () => {
	it( 'renders the Publisher Insights heading', () => {
		render( <PublisherInsightsPage /> );
		expect(
			screen.getByRole( 'heading', { name: 'Publisher Insights' } )
		).toBeInTheDocument();
	} );

	it( 'shows the no-data placeholder until a data layer lands', () => {
		render( <PublisherInsightsPage /> );
		expect( screen.getByText( '(no data yet)' ) ).toBeInTheDocument();
	} );
} );

/* eslint-env jest */
/**
 * SourceCounts widget — reads ONLY the `source-counts:view` node's slice via
 * useNodeState and renders the per-source proportion bars. It is mounted onto a
 * live graph node so the render reflects the published slice.
 */

import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { Core } from '@newspack-nodes/runtime';
import { SourceCountsViewNode } from '../../nodes/source-counts-view-node';
import { SourceCounts } from '../SourceCounts';

beforeEach( () => Core.reset() );

// Mount the view node under its canonical name and publish a slice.
function mountView( slice ) {
	const node = new SourceCountsViewNode();
	node.name = 'source-counts:view';
	if ( slice ) {
		node.setState( 'view', slice );
	}
	return node;
}

describe( 'SourceCounts', () => {
	it( 'renders one proportion bar per source, sized by share of the total', () => {
		mountView( { sources: { releases: 2, community: 1 } } );
		const { container } = render( <SourceCounts /> );
		expect( screen.getByText( 'releases' ) ).toBeInTheDocument();
		expect( screen.getByText( 'community' ) ).toBeInTheDocument();
		const bars = container.querySelectorAll( '.eai-insights__bar-fill' );
		expect( bars.length ).toBe( 2 );
		// releases = 2 of 3 → ~66.6%.
		expect( bars[ 0 ].style.width ).toContain( '66.6' );
	} );

	it( 'shows an empty state when there are no sources', () => {
		mountView( { sources: {} } );
		render( <SourceCounts /> );
		expect( screen.queryByText( 'releases' ) ).not.toBeInTheDocument();
		expect( screen.getByText( /no sources yet/i ) ).toBeInTheDocument();
	} );

	it( 're-renders when its view node publishes a new slice', () => {
		const node = mountView( { sources: {} } );
		render( <SourceCounts /> );
		act( () => node.setState( 'view', { sources: { releases: 5 } } ) );
		expect( screen.getByText( 'releases' ) ).toBeInTheDocument();
	} );

	it( 'surfaces a slice error as a notice', () => {
		mountView( { sources: {}, error: 'counts read failed' } );
		render( <SourceCounts /> );
		expect( screen.getByRole( 'alert' ).textContent ).toMatch(
			/counts read failed/
		);
	} );
} );

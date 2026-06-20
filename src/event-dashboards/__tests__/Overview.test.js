/**
 * Overview — the hub's at-a-glance landing tab (the first paint). A thin view
 * over useTopologyManager: a topology-count summary, a card per topology with
 * health/state + console deep-links, and a New-Topology link. The hook's data
 * contract is exercised by its own suite; here it's mocked.
 */

import { render } from '@testing-library/react';
import Overview from '../Overview';

jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyManager: jest.fn(),
} ) );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );

function hookValue( overrides = {} ) {
	return {
		topologies: [],
		supervisor: null,
		currentTime: 2000,
		activate: jest.fn(),
		deactivate: jest.fn(),
		restart: jest.fn(),
		connected: true,
		...overrides,
	};
}

afterEach( () => useTopologyManager.mockReset() );

describe( 'Overview', () => {
	it( 'summarizes the topology + active counts', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{
						name: 'alpha',
						source: 'user',
						active: true,
						health: 'ok',
					},
					{
						name: 'beta',
						source: 'stock',
						active: false,
						health: 'ok',
					},
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect( container.textContent ).toMatch( /2 topologies/ );
		expect( container.textContent ).toMatch( /1 active/ );
	} );

	it( 'renders a card per topology with console + edit deep-links', () => {
		useTopologyManager.mockReturnValue(
			hookValue( {
				topologies: [
					{
						name: 'alpha',
						source: 'user',
						active: true,
						health: 'ok',
					},
				],
			} )
		);
		const { container } = render( <Overview /> );
		expect(
			container
				.querySelector( '.nodes-overview__name' )
				.getAttribute( 'href' )
		).toContain( 'topology=alpha' );
		expect(
			container
				.querySelector( '.nodes-overview__edit' )
				.getAttribute( 'href' )
		).toContain( 'edit=1' );
	} );

	it( 'offers a New Topology deep-link', () => {
		useTopologyManager.mockReturnValue( hookValue() );
		const { container } = render( <Overview /> );
		expect(
			container
				.querySelector( '.nodes-overview__new' )
				.getAttribute( 'href' )
		).toContain( 'new=1' );
	} );
} );

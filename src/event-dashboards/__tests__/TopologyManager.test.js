/**
 * TopologyManager UI-surface tests — the thin view over the useTopologyManager
 * hook. The hook's data contract (poll, merge, mutations) is exercised by its
 * own suite; here we mock it to hand back a fixed `topologies` list plus spy
 * mutations, and assert the rendered DOM:
 *  - both topologies render with name + source badge;
 *  - the active one renders its TopologySection live subtree;
 *  - the inactive one renders a "Stopped" row;
 *  - clicking the inactive toggle calls activate, the active toggle calls
 *    deactivate, and the active restart button calls restart.
 */

import { render, fireEvent } from '@testing-library/react';
import TopologyManager from '../TopologyManager';

jest.mock( '../hooks/useTopologyManager', () => ( {
	__esModule: true,
	useTopologyManager: jest.fn(),
} ) );

const { useTopologyManager } = require( '../hooks/useTopologyManager' );

// A live status section for the active topology. The shape mirrors the enriched
// worker-status MODEL slices the hook now attaches per active topology (graph +
// workers + the same rate/segment/time maps WorkerStatus passes to
// TopologySection), so the manager tree renders with the same richness rather
// than a degraded `{ graph, workers }` reduction.
//
// The worker's `handler` MATCHES the graph's logic-node vertex name (`producer`)
// so `workersByHandler.get('producer')` is non-empty and a real node row renders
// — exercising the `byteRates[ key ]` read in TreeEntity's NodeRow that
// white-screened the tab whenever rates weren't threaded through.
function activeStatus() {
	return {
		graph: {
			nodes: [ { name: 'producer', kind: 'logic' } ],
			edges: [],
		},
		workers: [
			{
				type: 'alpha',
				handler: 'producer',
				partition: 0,
				source: '',
				status: 'running',
				started_at: 1000,
			},
		],
		byteRates: { 'producer-0-': 2048 },
		writeRates: {},
		segmentSize: 64 * 1024 * 1024,
		currentTime: 2000,
		prevSegments: {},
		removingSegments: {},
	};
}

function hookValue( overrides = {} ) {
	return {
		topologies: [],
		supervisor: null,
		activate: jest.fn( () => Promise.resolve() ),
		deactivate: jest.fn( () => Promise.resolve() ),
		restart: jest.fn( () => Promise.resolve() ),
		connected: true,
		...overrides,
	};
}

afterEach( () => {
	useTopologyManager.mockReset();
} );

test( 'renders every topology with its name and source badge', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: activeStatus(),
				},
				{
					name: 'beta',
					source: 'user',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );

	const names = [ ...container.querySelectorAll( '.nodes-tm__name' ) ].map(
		( n ) => n.textContent
	);
	expect( names ).toEqual( [ 'alpha', 'beta' ] );
	expect( container.querySelector( '.nodes-tm__badge--stock' ) ).toBeTruthy();
	expect( container.querySelector( '.nodes-tm__badge--user' ) ).toBeTruthy();
} );

test( 'renders the user-shadows-stock badge for source "both"', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'gamma',
					source: 'both',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );
	expect( container.querySelector( '.nodes-tm__badge--both' ) ).toBeTruthy();
} );

test( 'active topology renders its live TopologySection subtree; inactive renders Stopped', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 2,
					status: activeStatus(),
				},
				{
					name: 'beta',
					source: 'user',
					active: false,
					num_partitions: 1,
					status: null,
				},
			],
		} )
	);

	const { container, getByText } = render( <TopologyManager /> );

	// The active topology's TopologySection renders the .tsl tree.
	expect( container.querySelector( '.topology-section' ) ).toBeTruthy();
	// The inactive topology renders the Stopped placeholder.
	expect( container.querySelector( '.nodes-tm__stopped' ) ).toBeTruthy();
	expect( getByText( 'Stopped' ) ).toBeTruthy();
} );

test( 'active topology renders a node row with its read rate (not a crash, not 0 B/s)', () => {
	useTopologyManager.mockReturnValue(
		hookValue( {
			topologies: [
				{
					name: 'alpha',
					source: 'stock',
					active: true,
					num_partitions: 1,
					status: activeStatus(),
				},
			],
		} )
	);

	const { container } = render( <TopologyManager /> );

	// A real node row rendered (the worker's handler matched a graph vertex).
	const rate = container.querySelector( '.connector-rate' );
	expect( rate ).toBeTruthy();
	// And it shows the model's actual rate, not a degraded 0 B/s placeholder.
	expect( rate.textContent ).toContain( '2' );
	expect( rate.textContent ).not.toContain( '0 B/s' );
} );

test( 'clicking the inactive toggle calls activate(name)', () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'beta',
				source: 'user',
				active: false,
				num_partitions: 1,
				status: null,
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const toggle = container.querySelector( '.nodes-tm__toggle' );
	expect( toggle.getAttribute( 'aria-checked' ) ).toBe( 'false' );
	fireEvent.click( toggle );

	expect( value.activate ).toHaveBeenCalledWith( 'beta' );
	expect( value.deactivate ).not.toHaveBeenCalled();
} );

test( 'clicking the active toggle calls deactivate(name)', () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'alpha',
				source: 'stock',
				active: true,
				num_partitions: 2,
				status: activeStatus(),
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const toggle = container.querySelector( '.nodes-tm__toggle.is-on' );
	expect( toggle.getAttribute( 'aria-checked' ) ).toBe( 'true' );
	fireEvent.click( toggle );

	expect( value.deactivate ).toHaveBeenCalledWith( 'alpha' );
	expect( value.activate ).not.toHaveBeenCalled();
} );

test( 'clicking the restart button on an active topology calls restart(name)', () => {
	const value = hookValue( {
		topologies: [
			{
				name: 'alpha',
				source: 'stock',
				active: true,
				num_partitions: 2,
				status: activeStatus(),
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const restartBtn = container.querySelector( '.nodes-tm__restart' );
	expect( restartBtn ).toBeTruthy();
	fireEvent.click( restartBtn );

	expect( value.restart ).toHaveBeenCalledWith( 'alpha' );
} );

test( 'a rejected mutation does not crash the render', () => {
	const value = hookValue( {
		activate: jest.fn( () => Promise.reject( new Error( 'boom' ) ) ),
		topologies: [
			{
				name: 'beta',
				source: 'user',
				active: false,
				num_partitions: 1,
				status: null,
			},
		],
	} );
	useTopologyManager.mockReturnValue( value );

	const { container } = render( <TopologyManager /> );
	const toggle = container.querySelector( '.nodes-tm__toggle' );
	expect( () => fireEvent.click( toggle ) ).not.toThrow();
	expect( value.activate ).toHaveBeenCalledWith( 'beta' );
} );

test( 'shows a connection banner when not connected', () => {
	useTopologyManager.mockReturnValue(
		hookValue( { connected: false, topologies: [] } )
	);

	const { container } = render( <TopologyManager /> );
	expect(
		container.querySelector( '.newspack-nodes-connection-banner' )
	).toBeTruthy();
} );

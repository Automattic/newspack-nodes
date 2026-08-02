/**
 * useTopologyCatalog — a read over the `topologies:catalog` node.
 *
 * The ordering this pins: TopologyConsole calls useTopologyCatalog BEFORE
 * useConsoleGraph, so on first render the node does not exist yet. The hook has
 * to pick it up when it appears, or the Path menu stays frozen on the
 * page-load seed and never reflects a `wp nodes activate` from elsewhere.
 */

import { renderHook, act } from '@testing-library/react';
import { Core, mountExospine } from '@newspack-nodes/runtime';
import names from '../../../runtime/reserved-node-names.json';
import { TopologyCatalogNode } from '../../nodes/topology-catalog-node';
import { useTopologyCatalog, CATALOG_NODE } from '../useTopologyCatalog';
import { newMessage, VALUE } from '../../../runtime/message';

// Distinct from the seed below AND from the 1 fallback, so a hook stuck on the
// seed — or one defaulting the count — fails rather than coincidentally passing.
const LIVE = [ { name: 'combined', num_partitions: 6, active: true } ];

describe( 'useTopologyCatalog', () => {
	beforeEach( () => {
		Core.reset();
		window.NewspackNodesData = {
			topologyWorkers: { seeded: 2 },
			activeTopologies: [ 'seeded' ],
			configNumPartitions: 1,
		};
	} );

	it( 'seeds from the page-load snapshot before the node exists', () => {
		const { result } = renderHook( () => useTopologyCatalog() );
		expect( result.current.partitions ).toEqual( { seeded: 2 } );
		expect( result.current.active ).toEqual( [ 'seeded' ] );
	} );

	it( 'picks up a node that mounts AFTER it, and follows its publishes', () => {
		const { result, rerender } = renderHook( () => useTopologyCatalog() );

		// The graph hook mounts the node on a later commit.
		const node = new TopologyCatalogNode();
		node.name = CATALOG_NODE;
		rerender();

		const reply = newMessage();
		reply[ VALUE ] = { name: 'list', payload: { topologies: LIVE } };
		act( () => {
			node.fill( reply );
		} );

		expect( result.current.partitions ).toEqual( { combined: 6 } );
		expect( result.current.active ).toEqual( [ 'combined' ] );
		expect( result.current.entries ).toEqual( LIVE );
	} );

	it( 'reload() fires the node rather than waiting out the interval', () => {
		const node = new TopologyCatalogNode();
		node.name = CATALOG_NODE;
		const fire = jest.spyOn( node, 'fire' ).mockImplementation( () => {} );

		const { result } = renderHook( () => useTopologyCatalog() );
		act( () => {
			result.current.reload();
		} );

		expect( fire ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'reload() is inert when no graph is mounted', () => {
		const { result } = renderHook( () => useTopologyCatalog() );
		expect( () => result.current.reload() ).not.toThrow();
	} );

	describe( 'owning the node', () => {
		let host;
		afterEach( () => {
			host?.teardown();
			host = null;
			Core.cleanupAllNodes?.();
		} );

		// A passenger: it mounts onto a backbone the console owns, never its own.
		const mountHost = () => {
			act( () => {
				host = mountExospine( () => {} );
			} );
		};

		it( 'mounts and wires its own node once a backbone comes up', () => {
			const { rerender } = renderHook( () => useTopologyCatalog() );
			expect( Core.node( CATALOG_NODE ) ).toBeFalsy();

			mountHost();
			rerender();

			const node = Core.node( CATALOG_NODE );
			expect( node ).toBeInstanceOf( TopologyCatalogNode );
			// Sink is the interpreter, so `fire()` emits through _http's lock.
			expect( node.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
			// Router peels `_http`; the reply comes back TO=FROM to this node.
			expect( node.target ).toBe( `${ names.HTTP }/topologies` );
			// >1000 hitchhikes the router tick instead of taking its own slot.
			expect( node.interval_ms ).toBe( 10000 );
		} );

		it( 'does not replace a node that already exists', () => {
			mountHost();
			const { rerender } = renderHook( () => useTopologyCatalog() );
			const first = Core.node( CATALOG_NODE );

			rerender();

			expect( Core.node( CATALOG_NODE ) ).toBe( first );
		} );

		it( 'removes its node on unmount', () => {
			mountHost();
			const { unmount } = renderHook( () => useTopologyCatalog() );
			expect( Core.node( CATALOG_NODE ) ).toBeDefined();

			unmount();

			expect( Core.node( CATALOG_NODE ) ).toBeFalsy();
		} );
	} );
} );

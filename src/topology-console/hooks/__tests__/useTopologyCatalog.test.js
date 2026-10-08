/**
 * useTopologyCatalog — the Path menu's `topology-catalog:fetch` node, mounted
 * as a passenger on the exospine.
 *
 * The ordering this pins: TopologyConsole calls useTopologyCatalog BEFORE
 * useConsoleGraph, so the catalog's mount runs ahead of the console's. A
 * passenger mount clips its node on without taking the graph's ownership, so
 * the console still owns Reset Graph, and the catalog re-attaches whenever the
 * console replaces the backbone under it.
 */

import { renderHook, act } from '@testing-library/react';
import { Core, mountExospine, TO } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { TapNode } from '../../../runtime/tap-node';
import names from '../../../runtime/reserved-node-names.json';
import {
	CATALOG_NODE,
	TopologyCatalogNode,
} from '../../nodes/topology-catalog-node';
import { useTopologyCatalog } from '../useTopologyCatalog';

// Distinct from the seed below AND from the 1 fallback, so a hook stuck on the
// seed — or one defaulting the count — fails rather than coincidentally passing.
const LIVE = [ { name: 'combined', num_partitions: 6, active: true } ];

/** The Tap of the `topologies` group, the CI the catalog sends to. */
const TOPOLOGIES_TAP = 'topologies:shell';

/** Let the session fetch and every POST in flight answer. */
const settle = () =>
	act( async () => {
		for ( let i = 0; i < 5; i++ ) {
			await new Promise( ( r ) => setTimeout( r, 0 ) );
		}
	} );

/**
 * Mount the hook, then stop the Router's own 1s slot so no wall-clock tick
 * fires the catalog behind the test's back.
 *
 * @return {Object} The renderHook handle.
 */
const mountCatalog = () => {
	const hook = renderHook( () => useTopologyCatalog() );
	Core.node( names.ROUTER )?.stopTimer();
	return hook;
};

describe( 'useTopologyCatalog', () => {
	let replyFor;
	let host;

	beforeEach( () => {
		Core.reset();
		window.NewspackNodesData = {
			restUrl: '/wp-json/',
			nonce: 'NONCE',
			topologyWorkers: { seeded: 2 },
			activeTopologies: [ 'seeded' ],
			configNumPartitions: 1,
		};
		replyFor = jest.fn( () => ( { topologies: LIVE } ) );
		installFakeCommandWire( ( m ) => replyFor( m ) );
	} );

	afterEach( () => {
		host?.teardown();
		host = null;
		Core.reset();
	} );

	it( 'seeds from the page-load snapshot before the first reply', () => {
		const { result } = mountCatalog();
		expect( result.current.partitions ).toEqual( { seeded: 2 } );
		expect( result.current.active ).toEqual( [ 'seeded' ] );
		expect( result.current.entries ).toEqual( [] );
	} );

	it( 'mounts its own node, aimed at the topologies Tap', () => {
		mountCatalog();

		const node = Core.node( CATALOG_NODE );
		expect( node ).toBeInstanceOf( TopologyCatalogNode );
		expect( CATALOG_NODE ).toBe( 'topology-catalog:fetch' );
		// Sink is the interpreter, so `fire()` emits through _http's lock.
		expect( node.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
		expect( node.target ).toBe( 'topologies:shell/_http/topologies' );
		// >1000 hitchhikes the router tick instead of taking its own slot.
		expect( node.interval_ms ).toBe( 10000 );
	} );

	it( 'sends `topologies dump` through the topologies Tap and publishes the reply', async () => {
		const { result } = mountCatalog();
		await settle();
		const interpreter = Core.node( names.COMMAND_INTERPRETER );
		const sent = [];
		const fill = interpreter.fill.bind( interpreter );
		jest.spyOn( interpreter, 'fill' ).mockImplementation( ( m ) => {
			sent.push( m[ TO ] );
			fill( m );
		} );

		act( () => result.current.reload() );
		await settle();

		expect( sent[ 0 ] ).toBe( 'topologies:shell/_http/topologies' );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
		expect( Core.node( TOPOLOGIES_TAP ).counter ).toBe( 1 );
		expect( result.current.partitions ).toEqual( { combined: 6 } );
		expect( result.current.active ).toEqual( [ 'combined' ] );
		expect( result.current.entries ).toEqual( LIVE );
	} );

	it( 'keeps the topologies Tap standing while it is mounted, and only then', () => {
		const { unmount } = mountCatalog();
		expect( Core.node( TOPOLOGIES_TAP ) ).toBeInstanceOf( TapNode );

		unmount();

		expect( Core.node( TOPOLOGIES_TAP ) ).toBeFalsy();
		expect( Core.node( CATALOG_NODE ) ).toBeFalsy();
	} );

	it( 'rides as a passenger, leaving the console its owner', () => {
		mountCatalog();
		// Its own mount stands, and owns nothing.
		expect( Core.backboneMounts ).toHaveLength( 1 );
		expect( Core.backboneOwner ).toBeNull();

		act( () => {
			host = mountExospine( () => {} );
		} );

		expect( Core.backboneOwner ).not.toBeNull();
		expect( Core.backboneOwner.passenger ).toBe( false );
		expect( Core.rebuildable ).toBe( true );
	} );

	it( 're-attaches to the backbone a Reset Graph puts up', () => {
		const { result } = mountCatalog();
		act( () => {
			host = mountExospine( () => {} );
		} );
		const before = Core.node( CATALOG_NODE );

		act( () => Core.bumpGraphGeneration() );

		const after = Core.node( CATALOG_NODE );
		expect( after ).toBeInstanceOf( TopologyCatalogNode );
		expect( after ).not.toBe( before );
		expect( after.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
		expect( Core.node( TOPOLOGIES_TAP ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
		// The hook re-rendered onto the new node, so reload reaches it.
		const fire = jest.spyOn( after, 'fire' ).mockImplementation( () => {} );
		act( () => result.current.reload() );
		expect( fire ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'carries the live catalog across a Reset Graph, never the seed', async () => {
		const { result } = mountCatalog();
		act( () => {
			host = mountExospine( () => {} );
		} );
		await settle();
		act( () => result.current.reload() );
		await settle();
		expect( result.current.partitions ).toEqual( { combined: 6 } );
		const live = result.current.partitions;

		act( () => Core.bumpGraphGeneration() );

		expect( result.current.partitions ).toEqual( { combined: 6 } );
		expect( result.current.active ).toEqual( [ 'combined' ] );
		// The same object, so the console's path options do not rebuild.
		expect( result.current.partitions ).toBe( live );
	} );

	it( 'keeps one node across re-renders', () => {
		const { rerender } = mountCatalog();
		const first = Core.node( CATALOG_NODE );
		expect( first ).toBeInstanceOf( TopologyCatalogNode );

		rerender();

		expect( Core.node( CATALOG_NODE ) ).toBe( first );
	} );

	it( 'reload() is inert once the catalog has unmounted', () => {
		const { result, unmount } = mountCatalog();
		const { reload } = result.current;
		unmount();
		expect( () => reload() ).not.toThrow();
	} );
} );

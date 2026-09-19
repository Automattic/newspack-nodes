/**
 * TopologyCatalogNode tests — the Path menu's catalog, now a graph node.
 *
 * It was a hook calling a one-shot client, i.e. its own POST every tick
 * beside the batched one the console already sends. As a node it emits through
 * `_http` during the Router's TIMER notify, inside the same lock.
 */

import { Core } from '../../../runtime/core';
import { newMessage, TO, VALUE } from '../../../runtime/message';
import { TopologyCatalogNode } from '../topology-catalog-node';

const reply = ( topologies ) => {
	const m = newMessage();
	m[ VALUE ] = { name: 'dump', payload: { topologies } };
	return m;
};

// Distinct from the 1 fallback AND from each other, so a dropped or defaulted
// num_partitions is visible rather than coincidental.
const LIST = [
	{ name: 'firehose', num_partitions: 4, active: true },
	{ name: 'combined', num_partitions: 7, active: false },
];

describe( 'TopologyCatalogNode', () => {
	let node;

	beforeEach( () => {
		Core.reset();
		window.NewspackNodesData = {
			topologyWorkers: { seeded: 2 },
			activeTopologies: [ 'seeded' ],
			configNumPartitions: 3,
		};
		node = new TopologyCatalogNode();
		node.name = 'topology-catalog:fetch';
	} );

	it( 'seeds from the page-load snapshot before any reply', () => {
		expect( node.catalog ).toEqual( {
			partitions: { seeded: 2 },
			active: [ 'seeded' ],
			entries: [],
		} );
	} );

	it( 'publishes partitions, active and raw entries from a reply', () => {
		node.fill( reply( LIST ) );
		expect( node.catalog ).toEqual( {
			partitions: { firehose: 4, combined: 7 },
			active: [ 'firehose' ],
			entries: LIST,
		} );
	} );

	it( 'falls back to configNumPartitions when an entry omits num_partitions', () => {
		node.fill( reply( [ { name: 'bare', active: false } ] ) );
		expect( node.catalog.partitions ).toEqual( { bare: 3 } );
	} );

	it( 'keeps the last-good catalog when a reply is malformed', () => {
		node.fill( reply( LIST ) );
		const good = node.catalog;
		node.fill( reply( undefined ) );
		expect( node.catalog ).toBe( good );
	} );

	it( 'applies a genuinely empty list, collapsing the menu', () => {
		node.fill( reply( LIST ) );
		node.fill( reply( [] ) );
		expect( node.catalog.entries ).toEqual( [] );
		expect( node.catalog.active ).toEqual( [] );
	} );

	it( 'keeps a stable reference when a poll returns identical data', () => {
		node.fill( reply( LIST ) );
		const first = node.catalog;
		node.fill( reply( LIST ) );
		expect( node.catalog ).toBe( first );
	} );

	it( 'notifies `catalog` once per changed reply', () => {
		let heard = 0;
		node.register( 'catalog', 'probe-6612', () => heard++ );
		node.fill( reply( LIST ) );
		node.fill( reply( LIST ) );
		expect( heard ).toBe( 1 );
		expect( node.setStateCache.catalog ).toBeUndefined();
	} );

	// The seed IS the last publication, so a first poll answering exactly
	// what the page localized changes nothing and announces nothing.
	it( 'publishes nothing when the first poll matches the seed', () => {
		window.NewspackNodesData = {
			topologyWorkers: {},
			activeTopologies: [],
			configNumPartitions: 3,
		};
		const seeded = new TopologyCatalogNode();
		seeded.name = 'topology-catalog:seeded';
		const seed = seeded.catalog;
		let heard = 0;
		seeded.register( 'catalog', 'probe-7043', () => heard++ );
		seeded.fill( reply( [] ) );
		expect( heard ).toBe( 0 );
		expect( seeded.catalog ).toBe( seed );
	} );

	it( 'dumpNode omits the catalog, keeps the bridge', () => {
		node.fill( reply( LIST ) );
		const dump = node.dumpNode();
		expect( dump ).not.toHaveProperty( 'catalog' );
		expect( dump ).toHaveProperty( 'registrations' );
		expect( dump ).toHaveProperty( 'setStateCache' );
	} );

	// The batching contract: it emits into its SINK (interpreter → `_http`)
	// during the tick, never through a standalone client of its own.
	it( 'mints `dump` into its sink rather than posting on its own', () => {
		const sent = [];
		node.sink = { fill: ( m ) => sent.push( m ) };
		node.target = '_http/topologies';
		// Node.command returns null unmintable; pin the addressed happy path.
		node.command = ( name, args ) => {
			const m = newMessage();
			m[ TO ] = node.target;
			m[ VALUE ] = { name, arguments: args };
			return m;
		};

		node.fire();

		expect( sent ).toHaveLength( 1 );
		expect( sent[ 0 ][ VALUE ].name ).toBe( 'dump' );
		expect( sent[ 0 ][ TO ] ).toBe( '_http/topologies' );
	} );

	// @longform
	// The headline claim, end to end: with the interpreter's `_http` LOCKED —
	// which is what the Router's http.lock() does — a tick's emission is
	// buffered rather than posted, so it leaves in the same request as the
	// console's other polls instead of a standalone fetch of its own.
	it( 'buffers into a locked `_http` instead of posting on its own', () => {
		const posted = [];
		const buffered = [];
		const http = {
			locked: true,
			fill: ( m ) => buffered.push( m ),
		};
		// Stand in the router leg: peel `_http`, hand the rest to the node.
		node.sink = {
			fill: ( m ) => {
				if ( String( m[ TO ] ).startsWith( '_http/' ) ) {
					http.fill( m );
					return;
				}
				posted.push( m );
			},
		};
		node.target = '_http/topologies';
		node.command = ( name, args ) => {
			const m = newMessage();
			m[ TO ] = node.target;
			m[ VALUE ] = { name, arguments: args };
			return m;
		};

		node.fire();

		expect( buffered ).toHaveLength( 1 );
		expect( posted ).toHaveLength( 0 );
		expect( buffered[ 0 ][ VALUE ].name ).toBe( 'dump' );
	} );

	it( 'does not emit without a sink', () => {
		expect( () => node.fire() ).not.toThrow();
	} );
} );

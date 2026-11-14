/**
 * autoLayout over the station's Overview tab with the debug overlay open: the
 * fleet board's sources and mutations built by the real `useTopologyManager`
 * and the probe stream by the real topic-probe source, each under the page's
 * `SourcesProvider`, and the overlay's REPL by `useDebugRepl`, read back
 * through `coreToGraph()` as the overlay reads it.
 */

import { renderHook } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core } from '../../../runtime/core';
import { ShellNode } from '../../../runtime/shell-node';
import names from '../../../runtime/reserved-node-names.json';
import { useDebugRepl } from '../../../debug-overlay/useDebugRepl';
import {
	useConnected,
	useTopologyManager,
} from '../../../event-dashboards/hooks/useTopologyManager';
import { SourcesProvider, useSource } from '@newspack-nodes/shared/sources';
import '../../../event-dashboards/views';
import { coreToGraph } from '../coreToGraph';
import { autoLayout, drawnCost } from '../autoLayout';

/** The fleet board's group Tap, which every one of its Fetchers feeds. */
const HUB = 'topologies:shell';

class FakeEventSource {
	addEventListener() {}
	close() {}
}

/**
 * Mount the Overview tab's graph and the overlay's REPL, then read the graph.
 *
 * @return {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} What the overlay's canvas lays out.
 */
function overviewGraph() {
	const { unmount } = renderHook(
		() => {
			useConnected( useTopologyManager( {} ) );
			useSource( 'nodes/topicprobe' );
		},
		{ wrapper: SourcesProvider }
	);
	const shell = new ShellNode();
	shell.sink = Core.node( names.COMMAND_INTERPRETER );
	const repl = renderHook( () => useDebugRepl( true, shell ) );
	const graph = coreToGraph();
	repl.unmount();
	unmount();
	return graph;
}

/**
 * A source's Fetcher, by the prefix its live source names its nodes under.
 *
 * @param {Object<string,Object>} at     Node id => position.
 * @param {string}                prefix The source's name, `/` read as `:`.
 * @return {string} The Fetcher's id.
 */
const fetcherOf = ( at, prefix ) =>
	Object.keys( at ).find(
		( id ) => id.startsWith( prefix ) && id.endsWith( ':fetch' )
	);

describe( 'autoLayout — the station Overview in the debug overlay', () => {
	beforeEach( () => {
		installFakeCommandWire( () => undefined );
		Core.reset();
		global.EventSource = FakeEventSource;
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	} );

	/**
	 * Every card the station's slices and their shared `topologies:shell`
	 * sink hold, read off the graph as that Tap's weakly-connected component.
	 *
	 * @param {{nodes: Array<{id: string}>, edges: Array<{from: string, to: string}>}} graph The graph.
	 * @return {Set<string>} The component's node ids.
	 */
	const shellComponent = ( graph ) => {
		const seen = new Set( [ HUB ] );
		for ( let grew = true; grew;  ) {
			grew = false;
			for ( const { from, to } of graph.edges ) {
				if ( seen.has( from ) !== seen.has( to ) ) {
					seen.add( seen.has( from ) ? to : from );
					grew = true;
				}
			}
		}
		return seen;
	};

	it( 'gives every node a finite position', () => {
		const graph = overviewGraph();
		const laid = autoLayout( graph ).nodes;
		expect( laid.map( ( n ) => n.id ).sort() ).toEqual(
			graph.nodes.map( ( n ) => n.id ).sort()
		);
		const broken = laid.filter(
			( n ) =>
				! Number.isFinite( n.position?.x ) ||
				! Number.isFinite( n.position?.y )
		);
		expect( broken ).toEqual( [] );
	} );

	it( "seats no card from another block in the fleet board Tap's column", () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const slices = shellComponent( graph );
		const strays = Object.keys( at ).filter(
			( id ) => ! slices.has( id ) && at[ id ].x === at[ HUB ].x
		);
		expect( strays ).toEqual( [] );
	} );

	it( 'stacks every singleton in one block right of the slices and hub', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const slices = shellComponent( graph );
		const singletons = [
			'freshness:timer',
			'_completion',
			'_null',
			'_stdout',
			'_ui',
		];
		const right = Math.max( ...[ ...slices ].map( ( id ) => at[ id ].x ) );
		expect( singletons.filter( ( id ) => at[ id ].x <= right ) ).toEqual(
			[]
		);
		// One block: every singleton in one column, each on a row of its own.
		expect( new Set( singletons.map( ( id ) => at[ id ].x ) ).size ).toBe(
			1
		);
		expect( new Set( singletons.map( ( id ) => at[ id ].y ) ).size ).toBe(
			singletons.length
		);
	} );

	it( 'seats each mutation fetcher on its result’s column and gathers the two poll fetchers into one', () => {
		// A hub feeder whose wire covers no card stays in its band's column;
		// the poll fetchers' wires would, so both pin to one column.
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		for ( const slice of [
			'topologies:activate:',
			'topologies:deactivate:',
			'workers:restart:',
		] ) {
			expect( [
				slice,
				at[ `${ slice }fetch` ].x,
				at[ `${ slice }timer` ].y,
			] ).toEqual( [
				slice,
				at[ `${ slice }result` ].x,
				at[ `${ slice }tee` ].y,
			] );
		}
		const polls = [ 'nodes:topologies:', 'nodes:worker-status:' ].map(
			( prefix ) => fetcherOf( at, prefix )
		);
		expect( at[ polls[ 0 ] ].x ).toBe( at[ polls[ 1 ] ].x );
		for ( const fetch of polls ) {
			const slice = fetch.slice( 0, -'fetch'.length );
			expect( at[ fetch ].x ).toBeGreaterThan( at[ `${ slice }tee` ].x );
			expect( at[ `${ slice }timer` ].y ).toBe( at[ `${ slice }tee` ].y );
		}
	} );

	it( 'leaves a fetcher whose hub wire passes no card of another band', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at[ 'topologies:deactivate:fetch' ].x ).toBe(
			at[ 'topologies:deactivate:result' ].x
		);
	} );

	it( 'keeps a fetcher in its band’s column where its hub wire crosses no card', () => {
		// From its band's column, topologies:activate:fetch's wire to the Tap
		// passes over no card, so it has no reason to move right.
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		expect( at[ 'topologies:activate:fetch' ].x ).toBe(
			at[ 'topologies:activate:result' ].x
		);
		expect(
			drawnCost( at, graph.edges ).over.filter( ( hit ) =>
				hit.startsWith( 'topologies:activate:fetch→' )
			)
		).toEqual( [] );
	} );

	it( 'stands the fleet board Tap right of every fetcher, its wires over no card', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const fetchX = Math.max(
			...Object.keys( at )
				.filter( ( id ) => id.endsWith( ':fetch' ) )
				.map( ( id ) => at[ id ].x )
		);
		expect( at[ HUB ].x ).toBeGreaterThan( fetchX );
		const between = Object.keys( at ).filter(
			( id ) => at[ id ].x > fetchX && at[ id ].x < at[ HUB ].x
		);
		expect( between ).toEqual( [] );
		expect(
			drawnCost( at, graph.edges ).over.filter( ( hit ) =>
				hit.includes( `→${ HUB }` )
			)
		).toEqual( [] );
	} );

	it( 'keeps the heartbeat chain at the bottom-left, under the slices', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const slices = [ ...shellComponent( graph ) ];
		const bottom = Math.max( ...slices.map( ( id ) => at[ id ].y ) );
		for ( const id of [ '_heartbeat', '_http', '_output' ] ) {
			expect( [
				id,
				at[ id ].x < at[ HUB ].x,
				at[ id ].y > bottom,
			] ).toEqual( [ id, true, true ] );
		}
		expect( at._heartbeat.x ).toBe(
			Math.min( ...slices.map( ( id ) => at[ id ].x ) )
		);
	} );
} );

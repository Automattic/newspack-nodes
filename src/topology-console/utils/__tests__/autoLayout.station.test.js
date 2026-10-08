/**
 * autoLayout over the station's Overview tab with the debug overlay open: the
 * fleet board's slices and mutations built by the real `useTopologyManager`,
 * the probe stream by the real `useProbeStream`, and the overlay's REPL by
 * `useDebugRepl`, read back through `coreToGraph()` as the overlay reads it.
 */

import { renderHook } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core } from '../../../runtime/core';
import { ShellNode } from '../../../runtime/shell-node';
import names from '../../../runtime/reserved-node-names.json';
import { useDebugRepl } from '../../../debug-overlay/useDebugRepl';
import { useTopologyManager } from '../../../event-dashboards/hooks/useTopologyManager';
import { useProbeStream } from '../../../event-dashboards/hooks/useProbeStream';
import { coreToGraph } from '../coreToGraph';
import { autoLayout, X_STEP } from '../autoLayout';

/** The fleet board's group Tap, which every one of its Fetchers feeds. */
const HUB = 'shell:topologies';

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
	const { unmount } = renderHook( () => {
		useTopologyManager( {} );
		useProbeStream( 'topicprobe', { mode: 'history' } );
	} );
	const shell = new ShellNode();
	shell.sink = Core.node( names.COMMAND_INTERPRETER );
	const repl = renderHook( () => useDebugRepl( true, shell ) );
	const graph = coreToGraph();
	repl.unmount();
	unmount();
	return graph;
}

describe( 'autoLayout — the station Overview in the debug overlay', () => {
	beforeEach( () => {
		installFakeCommandWire( () => undefined );
		Core.reset();
		global.EventSource = FakeEventSource;
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	} );

	/**
	 * Every card the station's slices and their shared `shell:topologies`
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

	it( 'seats every fetcher in one column, its timer and tee level with it', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const fetch = at[ 'workers:restart:fetch' ];
		expect( [
			at[ 'topology-manager:fetch' ].x,
			at[ 'worker-status:fetch' ].x,
		] ).toEqual( [ fetch.x, fetch.x ] );
		expect( [
			at[ 'workers:restart:timer' ].y,
			at[ 'workers:restart:tee' ].y,
		] ).toEqual( [ fetch.y, fetch.y ] );
	} );

	it( 'leaves a fetcher whose hub wire passes no other feeder in its band', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		for ( const s of [ 'topologies:activate', 'topologies:deactivate' ] ) {
			expect( [ s, at[ `${ s }:fetch` ].x ] ).toEqual( [
				s,
				at[ `${ s }:result` ].x,
			] );
		}
	} );

	it( 'opens a clear column between the fetchers and the fleet board Tap', () => {
		const graph = overviewGraph();
		const at = Object.fromEntries(
			autoLayout( graph ).nodes.map( ( n ) => [ n.id, n.position ] )
		);
		const fetchX = at[ 'topology-manager:fetch' ].x;
		expect( at[ HUB ].x - fetchX ).toBeGreaterThan( X_STEP );
		const between = Object.keys( at ).filter(
			( id ) => at[ id ].x > fetchX && at[ id ].x < at[ HUB ].x
		);
		expect( between ).toEqual( [] );
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

/**
 * autoLayout over a graph the debug overlay really draws: event-logger-nodes'
 * Performance dashboard, built through the same `addSliceFetcher` calls its
 * hooks make, with the overlay's own REPL nodes mounted beside it, and read
 * back through `coreToGraph()` exactly as the overlay's canvas reads it.
 */

import { renderHook } from '@testing-library/react';
import {
	Core,
	Node,
	mountExospine,
	CommandInterpreterNode,
} from '@newspack-nodes/runtime';
import { addSliceFetcher } from '@newspack-nodes/shared/helpers/addSliceFetcher';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';
import { ShellNode } from '../../../runtime/shell-node';
import names from '../../../runtime/reserved-node-names.json';
import { useDebugRepl } from '../../../debug-overlay/useDebugRepl';
import { coreToGraph } from '../coreToGraph';
import { autoLayout, drawnCost, Y_PAD, Y_STEP } from '../autoLayout';
import SEEDS from './fixtures/autoLayout-seeds.json';

/** Stands in for every view and transform class; layout reads no class. */
class SliceView extends Node {}

/**
 * The `useCommandOnce` scopes the Performance dashboard mounts on load, each
 * as `[ scope, command, ci ]`.
 */
const ONE_SHOTS = [
	[ 'url-lookup', 'dump_url', 'performance' ],
	[ 'request-deeplink', 'search_requests', 'performance' ],
	[ 'url-deeplink', 'dump_url', 'performance' ],
	[ 'request-search', 'search_requests', 'performance' ],
	[ 'performance:grep_requests', 'grep_requests', 'performance' ],
	[ 'rules:dump', 'dump', 'rules' ],
	[ 'rules:upsert', 'upsert', 'rules' ],
	[ 'rules:delete', 'delete', 'rules' ],
];

/**
 * Build the Performance dashboard's graph on a live Core, mount the debug
 * overlay's REPL beside it, and lay out what the overlay's canvas reads.
 *
 * @param {{nodes: Array<string>, edges: Array<[string, string]>}} [beside] A graph laid out beside it.
 * @return {{at: Object<string,{x: number, y: number}>, edges: Array<{from: string, to: string}>}}
 * Position by node id, and the wires the canvas draws.
 */
function layOutPerformanceOverlay( beside = { nodes: [], edges: [] } ) {
	const { teardown } = mountExospine( ( { interpreter } ) => {
		const slice = ( subject, command, tee, extra = {} ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ subject }:fetch`,
				receiver: `${ subject }:in`,
				command,
				view: `${ subject }:view`,
				viewClass: SliceView,
				tee,
				target: egressPath( 'performance' ),
				...extra,
			} );
		// usePerformanceGraph: two polled slices on one Tee, two on demand.
		const tee = interpreter.makeNode( 'Tee', 'performance:tee' );
		slice( 'overview', 'overview', tee );
		slice( 'urls', 'urls', tee );
		interpreter
			.makeNode( 'Timer', 'performance:timer' )
			.connectNode( 'performance:tee' );
		slice(
			'url-detail',
			'dump_url',
			interpreter.makeNode( 'Timer', 'url-detail:timer' ),
			{
				transform: {
					name: 'url-detail:transform',
					nodeClass: SliceView,
				},
			}
		);
		slice(
			'request-detail',
			'dump_request',
			interpreter.makeNode( 'Timer', 'request-detail:timer' )
		);
		// useCommandOnce: a Tee, one slice, then the Timer feeding the Tee.
		for ( const [ scope, command, ci ] of ONE_SHOTS ) {
			slice(
				scope,
				command,
				interpreter.makeNode( 'Tee', `${ scope }:tee` ),
				{ view: `${ scope }:result`, target: egressPath( ci ) }
			);
			interpreter
				.makeNode( 'Timer', `${ scope }:timer` )
				.connectNode( `${ scope }:tee` );
		}
	} );
	const shell = new ShellNode();
	shell.sink = Core.node( names.COMMAND_INTERPRETER );
	const { unmount } = renderHook( () => useDebugRepl( true, shell ) );
	const graph = coreToGraph();
	graph.nodes.push( ...beside.nodes.map( ( id ) => ( { id } ) ) );
	graph.edges.push(
		...beside.edges.map( ( [ from, to ] ) => ( { from, to } ) )
	);
	const at = {};
	for ( const n of autoLayout( graph ).nodes ) {
		at[ n.id ] = n.position;
	}
	unmount();
	teardown();
	return { at, edges: graph.edges };
}

describe( 'autoLayout — the Performance dashboard in the debug overlay', () => {
	beforeEach( () => {
		Core.reset();
		CommandInterpreterNode.registerNodeClasses( { SliceView } );
	} );

	const COLUMN_2 = [
		'overview:view',
		'overview:fetch',
		'urls:fetch',
		'urls:view',
	];

	it( 'stacks each view outside its fetcher, the fetchers beside the tee', () => {
		const { at } = layOutPerformanceOverlay();
		const x = at[ 'overview:fetch' ].x;
		for ( const id of COLUMN_2 ) {
			expect( at[ id ].x ).toBe( x );
		}
		const byRow = [ ...COLUMN_2 ].sort( ( p, q ) => at[ p ].y - at[ q ].y );
		expect( byRow ).toEqual( COLUMN_2 );
	} );

	it( 'seats the slice column on whole grid rows', () => {
		const { at } = layOutPerformanceOverlay();
		for ( const id of COLUMN_2 ) {
			expect( [ id, ( ( at[ id ].y - Y_PAD ) / Y_STEP ) % 1 ] ).toEqual( [
				id,
				0,
			] );
		}
	} );

	it( 'keeps the slice column beside a graph whose exchange draws worse', () => {
		// Each block judges its own exchange, so seed 14962 keeping the
		// sweeps' order beside it leaves the slice column's exchange alone.
		const { at } = layOutPerformanceOverlay( SEEDS[ '14962' ] );
		const byRow = [ ...COLUMN_2 ].sort( ( p, q ) => at[ p ].y - at[ q ].y );
		expect( byRow ).toEqual( COLUMN_2 );
	} );

	it( 'runs every wire into the slice column clear of every other', () => {
		const { at, edges } = layOutPerformanceOverlay();
		const into = edges.filter( ( e ) => COLUMN_2.includes( e.to ) );
		expect( drawnCost( at, into ).crossings ).toEqual( [] );
	} );
} );

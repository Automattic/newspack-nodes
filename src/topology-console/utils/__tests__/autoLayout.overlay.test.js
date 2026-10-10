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
import { autoLayout, drawnCost, X_STEP, Y_PAD, Y_STEP } from '../autoLayout';
import SEEDS from './fixtures/autoLayout-seeds.json';

/** Stands in for every view and transform class; layout reads no class. */
class SliceView extends Node {}

/**
 * The `useCommandOnce` scopes the Performance dashboard mounts on load, each
 * as `[ scope, command, ci, group ]`.
 */
const ONE_SHOTS = [
	[ 'url-lookup', 'dump_url', 'performance', 'url' ],
	[ 'request-deeplink', 'search_requests', 'performance', 'request' ],
	[ 'url-deeplink', 'dump_url', 'performance', 'url' ],
	[ 'request-search', 'search_requests', 'performance', 'request' ],
	[
		'performance:grep_requests',
		'grep_requests',
		'performance',
		'performance',
	],
	[ 'rules:dump', 'dump', 'rules', 'rules' ],
	[ 'rules:upsert', 'upsert', 'rules', 'rules' ],
	[ 'rules:delete', 'delete', 'rules', 'rules' ],
];

/** Every group the dashboard's commands travel, one Tap each. */
const GROUPS = [ 'overview', 'url', 'request', 'performance', 'rules' ];

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
		const slice = ( subject, group, command, tee, extra = {} ) =>
			addSliceFetcher( interpreter, {
				fetcher: `${ subject }:fetch`,
				receiver: `${ subject }:in`,
				command,
				view: `${ subject }:view`,
				viewClass: SliceView,
				tee,
				target: egressPath( group, 'performance' ),
				...extra,
			} );
		// usePerformanceGraph: two polled slices on one Tee, two on demand.
		const tee = interpreter.makeNode( 'Tee', 'performance:tee' );
		slice( 'overview', 'overview', 'overview', tee );
		slice( 'urls', 'overview', 'urls', tee );
		interpreter
			.makeNode( 'Timer', 'performance:timer' )
			.connectNode( 'performance:tee' );
		slice(
			'url-detail',
			'url',
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
			'request',
			'dump_request',
			interpreter.makeNode( 'Timer', 'request-detail:timer' )
		);
		// useCommandOnce: a Tee, one slice, then the Timer feeding the Tee.
		for ( const [ scope, command, ci, group ] of ONE_SHOTS ) {
			slice(
				scope,
				group,
				command,
				interpreter.makeNode( 'Tee', `${ scope }:tee` ),
				{
					view: `${ scope }:result`,
					target: egressPath( group, ci ),
				}
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

	/** The two polled slices' Fetchers, both feeding `overview:shell`. */
	const FETCHERS = [ 'overview:fetch', 'urls:fetch' ];

	/** The column past them: the group Tap between the two slices' views. */
	const TAP_COLUMN = [ 'overview:view', 'overview:shell', 'urls:view' ];

	it( "draws the overview group's fan-in on its own Tap, one column past its fetchers", () => {
		const { at } = layOutPerformanceOverlay();
		const fetchX = at[ 'overview:fetch' ].x;
		expect( at[ 'urls:fetch' ].x ).toBe( fetchX );
		for ( const id of TAP_COLUMN ) {
			expect( [ id, at[ id ].x ] ).toEqual( [ id, fetchX + X_STEP ] );
		}
		const byRow = [ ...TAP_COLUMN ].sort(
			( p, q ) => at[ p ].y - at[ q ].y
		);
		expect( byRow ).toEqual( TAP_COLUMN );
		// The Tap centres on the two Fetchers it collects.
		expect( at[ 'overview:shell' ].y ).toBe(
			( at[ 'overview:fetch' ].y + at[ 'urls:fetch' ].y ) / 2
		);
	} );

	it( "gives every group its own Tap, none of them the console session's", () => {
		const { at, edges } = layOutPerformanceOverlay();
		for ( const group of GROUPS ) {
			expect( at[ `${ group }:shell` ] ).toBeDefined();
		}
		expect( edges.filter( ( e ) => '_shell' === e.to ) ).toEqual( [] );
	} );

	it( 'seats the overview slices on whole grid rows', () => {
		const { at } = layOutPerformanceOverlay();
		// The Tap is no slice card: it centres on its fan-in, a half row.
		const views = TAP_COLUMN.filter( ( id ) => 'overview:shell' !== id );
		for ( const id of [ ...FETCHERS, ...views ] ) {
			expect( [ id, ( ( at[ id ].y - Y_PAD ) / Y_STEP ) % 1 ] ).toEqual( [
				id,
				0,
			] );
		}
	} );

	it( 'seats url-detail:timer one row above url-detail:in, its fetcher centred', () => {
		// The band grows by the least that seats the timer: one row above
		// url-detail:in, with url-detail:fetch half way between its feeders.
		const { at } = layOutPerformanceOverlay();
		const row = ( id ) => ( at[ id ].y - Y_PAD ) / Y_STEP;
		const [ timer, inbox ] = [
			row( 'url-detail:timer' ),
			row( 'url-detail:in' ),
		];
		expect( inbox - timer ).toBe( 1 );
		expect( row( 'url-detail:fetch' ) ).toBe( ( timer + inbox ) / 2 );
	} );

	it( 'runs no wire over a card', () => {
		const { at, edges } = layOutPerformanceOverlay();
		expect( drawnCost( at, edges ).over ).toEqual( [] );
	} );

	it( 'keeps the Tap column beside a graph whose exchange draws worse', () => {
		// Each block judges its own exchange, so seed 14962 keeping the
		// sweeps' order beside it leaves the Tap column's exchange alone.
		const { at } = layOutPerformanceOverlay( SEEDS[ '14962' ] );
		const byRow = [ ...TAP_COLUMN ].sort(
			( p, q ) => at[ p ].y - at[ q ].y
		);
		expect( byRow ).toEqual( TAP_COLUMN );
	} );

	it( 'runs every wire into the Tap column clear of every other', () => {
		const { at, edges } = layOutPerformanceOverlay();
		const into = edges.filter( ( e ) => TAP_COLUMN.includes( e.to ) );
		expect( drawnCost( at, into ).crossings ).toEqual( [] );
	} );
} );

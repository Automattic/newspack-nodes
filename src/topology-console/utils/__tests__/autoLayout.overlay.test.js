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
	[ 'ask', 'ask', 'performance', 'performance' ],
	[ 'grep-requests', 'grep_requests', 'performance', 'performance' ],
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

	/**
	 * Each card's column and row in X_STEP and Y_STEP units from `first`.
	 *
	 * @param {Object<string,{x: number, y: number}>} at    Position by id.
	 * @param {string}                                first The stack's first card.
	 * @param {Array<[string, number, number]>}       cards Each card, column and row.
	 * @return {Array<[string, number, number]>} What the layout gives each.
	 */
	const relative = ( at, first, cards ) =>
		cards.map( ( [ id ] ) => [
			id,
			( at[ id ].x - at[ first ].x ) / X_STEP,
			( at[ id ].y - at[ first ].y ) / Y_STEP,
		] );

	/**
	 * A one-shot slice's six cards from its timer's row `r`: the timer and
	 * tee, the fetcher in column `f` half a row down, the receiver a row down,
	 * and its gate and result half a row under that.
	 *
	 * @param {string} s The scope.
	 * @param {number} r The timer's row.
	 * @param {number} f The fetcher's column.
	 * @return {Array<[string, number, number]>} Each card, column and row.
	 */
	const oneShot = ( s, r, f = 2 ) => [
		[ `${ s }:timer`, 0, r ],
		[ `${ s }:tee`, 1, r ],
		[ `${ s }:fetch`, f, 2 === f ? r + 0.5 : r ],
		[ `${ s }:in`, 0, r + 1 ],
		[ `${ s }:in:current`, 1, r + 1.5 ],
		[ `${ s }:result`, 2, r + 1.5 ],
	];

	it( 'stacks the url, overview and performance groups tight in the left stack', () => {
		const { at } = layOutPerformanceOverlay();
		const left = [
			...oneShot( 'url-deeplink', 0 ),
			[ 'url-detail:timer', 0, 2 ],
			[ 'url-detail:fetch', 2, 2.5 ],
			[ 'url-detail:in', 0, 3 ],
			[ 'url-detail:in:current', 1, 3.5 ],
			[ 'url-detail:transform', 2, 3.5 ],
			[ 'url-detail:view', 3, 3.5 ],
			...oneShot( 'url-lookup', 4.5, 3 ),
			[ 'url:shell', 4, 2.5 ],
			[ 'overview:in:current', 2, 8 ],
			[ 'overview:view', 3, 8 ],
			[ 'overview:in', 1, 8.5 ],
			[ 'overview:fetch', 2, 9 ],
			[ 'performance:timer', 0, 9.5 ],
			[ 'performance:tee', 1, 9.5 ],
			[ 'overview:shell', 3, 9.5 ],
			[ 'urls:fetch', 2, 10 ],
			[ 'urls:in', 1, 10.5 ],
			[ 'urls:in:current', 2, 11 ],
			[ 'urls:view', 3, 11 ],
			...oneShot( 'ask', 13 ),
			[ 'performance:shell', 3, 15 ],
			...oneShot( 'grep-requests', 15.5 ),
		];
		expect( relative( at, 'url-deeplink:timer', left ) ).toEqual( left );
	} );

	it( 'stacks the request and rules groups tight in the right stack, the REPL under them', () => {
		const { at } = layOutPerformanceOverlay();
		const right = [
			...oneShot( 'request-deeplink', 0 ),
			[ 'request-detail:timer', 0, 2 ],
			[ 'request-detail:fetch', 2, 2.5 ],
			[ 'request-detail:in', 0, 3 ],
			[ 'request:shell', 3.5, 3 ],
			[ 'request-detail:in:current', 1, 3.5 ],
			[ 'request-detail:view', 2, 3.5 ],
			...oneShot( 'request-search', 4.5 ),
			...oneShot( 'rules:delete', 8 ),
			...oneShot( 'rules:dump', 10.5 ),
			[ 'rules:shell', 3.5, 11 ],
			...oneShot( 'rules:upsert', 13 ),
			[ '_heartbeat', 0, 16.5 ],
			[ '_http', 1, 16.5 ],
			[ '_output', 2, 16.5 ],
			[ '_metadata', 0, 18.5 ],
			[ '_cwd', 1, 18.5 ],
		];
		expect( relative( at, 'request-deeplink:timer', right ) ).toEqual(
			right
		);
	} );

	it( 'runs every wire into the Tap column clear of every other', () => {
		const { at, edges } = layOutPerformanceOverlay();
		const into = edges.filter( ( e ) => TAP_COLUMN.includes( e.to ) );
		expect( drawnCost( at, into ).crossings ).toEqual( [] );
	} );
} );

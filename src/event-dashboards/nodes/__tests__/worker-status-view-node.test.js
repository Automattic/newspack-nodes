/**
 * worker-status:view tests — the render-state node React reads via
 * useNodeState('worker-status:view','view').
 *
 * Post-migration to substrate `_http`, the view follows the canonical
 * serversView pattern:
 *   - TM_ERROR goes to the base, which surfaces it on the view model's
 *     `error` without blanking what is on screen. A restart's failure lands
 *     on ITS own node, so this one only ever sees the poll's and broadcasts.
 *   - TM_STRUCT `{ action:'model', model }` from the transform stores + publishes
 *     the model (the dump_graph reply path: HttpOut → transform → view).
 *   - Each model publishes as the transform sent it, departures included:
 *     the row drawing a departed bar holds it, not this node.
 */

import {
	VALUE,
	TYPE,
	ID,
	TM_STRUCT,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { WorkerStatusViewNode } from '../worker-status-view-node';

beforeEach( () => Core.reset() );

// Construct the node directly (bare-new is fine in a test).
function makeView( name ) {
	const node = new WorkerStatusViewNode();
	node.name = name;
	return node;
}

// A model envelope from worker-status:transform.
function modelMsg( model ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = { action: 'model', model };
	return m;
}

// A failed restart reply: TM_ERROR set.
function restartErrorReply( id, payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
	m[ ID ] = id;
	m[ VALUE ] = { name: 'restart', payload };
	return m;
}

const baseModel = ( overrides = {} ) => ( {
	workers: [],
	logs: [],
	byteRates: {},
	writeRates: {},
	segmentSize: 1024,
	currentTime: 0,
	prevSegments: {},
	removingSegments: {},
	error: null,
	loading: false,
	...overrides,
} );

describe( 'worker-status:view — model publish', () => {
	test( 'a model message publishes setState("view", model)', () => {
		const v = makeView( 'worker-status:view' );
		const model = baseModel( {
			workers: [ { type: 'firehose-workers' } ],
		} );
		v.fill( modelMsg( model ) );
		expect( v.view ).toEqual( model );
	} );

	test( 'a later model replaces the published view', () => {
		const v = makeView( 'worker-status:view' );
		v.fill( modelMsg( baseModel( { currentTime: 1 } ) ) );
		v.fill( modelMsg( baseModel( { currentTime: 2 } ) ) );
		expect( v.view.currentTime ).toBe( 2 );
	} );
} );

describe( 'worker-status:view — pre-poll model', () => {
	test( 'publishes the empty model, so a render before the first poll is valid', () => {
		const v = makeView( 'worker-status:view' );
		expect( v.view ).toMatchObject( {
			workers: [],
			logs: [],
			segmentSize: 64 * 1024 * 1024,
			heartbeatIntervalS: 10,
		} );
	} );
} );

describe( 'worker-status:view — un-correlated TM_ERROR (global error)', () => {
	test( 'an un-correlated TM_ERROR (no matching pending) surfaces into view.error', () => {
		const v = makeView( 'worker-status:view' );
		v.fill( modelMsg( baseModel() ) );
		// Nothing correlates a restart here, so it takes the global error path.
		v.fill( restartErrorReply( 'never-stashed', 'broadcast failure' ) );
		expect( v.view.error ).toBe( 'broadcast failure' );
		expect( v.view.loading ).toBe( false );
	} );

	test( 'a TM_ERROR carrying a bare STRING VALUE still surfaces', () => {
		const v = makeView( 'worker-status:view' );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		m[ VALUE ] = 'NOT_AVAILABLE\n';

		v.fill( m );

		expect( v.view.error ).toContain( 'NOT_AVAILABLE' );
	} );
} );

describe( 'worker-status:view — departed segments', () => {
	test( "a model's departures replace the last model's", () => {
		const v = makeView( 'worker-status:view' );
		const seg = ( id ) => ( { id, size: 7340032 } );
		v.fill(
			modelMsg(
				baseModel( {
					removingSegments: { 'firehose.p3': [ seg( 4471 ) ] },
				} )
			)
		);
		v.fill(
			modelMsg(
				baseModel( {
					removingSegments: { 'jobs.p1': [ seg( 9902 ) ] },
				} )
			)
		);
		expect( v.view.removingSegments ).toEqual( {
			'jobs.p1': [ seg( 9902 ) ],
		} );
	} );
} );

describe( 'worker-status:view — node wiring', () => {
	test( 'names the node', () => {
		const v = makeView( 'worker-status:view' );
		expect( v.name ).toBe( 'worker-status:view' );
	} );

	test( 'fill increments the node counter so the overlay shows throughput', () => {
		const v = makeView( 'worker-status:view' );
		expect( v.counter ).toBe( 0 );
		v.fill( modelMsg( {} ) );
		v.fill( modelMsg( {} ) );
		expect( v.counter ).toBe( 2 );
	} );

	test( 'a frame carrying no struct is counted and changes nothing', () => {
		const v = makeView( 'worker-status:view' );
		v.fill( modelMsg( baseModel( { currentTime: 4471 } ) ) );
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ VALUE ] = 'dump_graph';
		v.fill( m );
		expect( v.counter ).toBe( 2 );
		expect( v.view.currentTime ).toBe( 4471 );
	} );

	test( 'declares has_target:false (terminal receiver — no out-port)', () => {
		expect( WorkerStatusViewNode.nodeSchema().has_target ).toBe( false );
	} );
} );

/**
 * workerstatus:view tests — the render-state node React reads via
 * useNodeState('workerstatus:view','view').
 *
 * Post-migration to substrate `_http`, the view follows the canonical
 * serversView pattern:
 *   - TM_ERROR goes to the base, which surfaces it on the view model's
 *     `error` without blanking what is on screen. A restart's failure lands
 *     on ITS own node, so this one only ever sees the poll's and broadcasts.
 *   - TM_STRUCT `{ action:'model', model }` from the transform stores + publishes
 *     the model (the dump_graph reply path: HttpOut → transform → view).
 *   - A model with non-empty removingSegments schedules a 400ms self-fill of
 *     `clear-removing` so the slide-out animation completes.
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

// A model envelope from workerstatus:transform.
function modelMsg( model ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = { action: 'model', model };
	return m;
}

// A control message: TM_STRUCT carrying { action, ... }.
function controlMsg( payload ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ VALUE ] = payload;
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

describe( 'workerstatus:view — model publish', () => {
	test( 'a model message publishes setState("view", model)', () => {
		const v = makeView( 'workerstatus:view' );
		const model = baseModel( {
			workers: [ { type: 'firehose-workers' } ],
		} );
		v.fill( modelMsg( model ) );
		expect( v.setStateCache.view ).toEqual( model );
	} );

	test( 'a later model replaces the published view', () => {
		const v = makeView( 'workerstatus:view' );
		v.fill( modelMsg( baseModel( { currentTime: 1 } ) ) );
		v.fill( modelMsg( baseModel( { currentTime: 2 } ) ) );
		expect( v.setStateCache.view.currentTime ).toBe( 2 );
	} );
} );

describe( 'workerstatus:view — pre-poll model', () => {
	test( 'publishes the empty model, so a render before the first poll is valid', () => {
		const v = makeView( 'workerstatus:view' );
		expect( v.setStateCache.view ).toMatchObject( {
			workers: [],
			logs: [],
			segmentSize: 64 * 1024 * 1024,
			heartbeatIntervalS: 10,
		} );
	} );
} );

describe( 'workerstatus:view — un-correlated TM_ERROR (global error)', () => {
	test( 'an un-correlated TM_ERROR (no matching pending) surfaces into view.error', () => {
		const v = makeView( 'workerstatus:view' );
		v.fill( modelMsg( baseModel() ) );
		// Nothing correlates a restart here, so it takes the global error path.
		v.fill( restartErrorReply( 'never-stashed', 'broadcast failure' ) );
		expect( v.setStateCache.view.error ).toBe( 'broadcast failure' );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );

	test( 'a TM_ERROR carrying a bare STRING VALUE still surfaces', () => {
		const v = makeView( 'workerstatus:view' );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		m[ VALUE ] = 'NOT_AVAILABLE\n';

		v.fill( m );

		expect( v.setStateCache.view.error ).toContain( 'NOT_AVAILABLE' );
	} );
} );

describe( 'workerstatus:view — removing-segment animation', () => {
	test( 'the slide-out clear arrives as a message, so the overlay counts it', () => {
		jest.useFakeTimers();
		try {
			const v = makeView( 'workerstatus:view' );
			v.fill(
				modelMsg(
					baseModel( {
						removingSegments: { 'jobs.p2': [ { id: 5, size: 3 } ] },
					} )
				)
			);
			jest.advanceTimersByTime( 400 );
			expect( v.counter ).toBe( 2 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'a model with removingSegments schedules a 400ms clear that blanks them', () => {
		jest.useFakeTimers();
		try {
			const v = makeView( 'workerstatus:view' );
			v.fill(
				modelMsg(
					baseModel( {
						removingSegments: {
							'firehose.p0': [ { id: 1, size: 9 } ],
						},
					} )
				)
			);
			expect( v.setStateCache.view.removingSegments ).toEqual( {
				'firehose.p0': [ { id: 1, size: 9 } ],
			} );
			jest.advanceTimersByTime( 400 );
			expect( v.setStateCache.view.removingSegments ).toEqual( {} );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'a clear-removing control blanks removingSegments and republishes', () => {
		const v = makeView( 'workerstatus:view' );
		v.fill(
			modelMsg(
				baseModel( {
					removingSegments: { 'firehose.p0': [ { id: 1, size: 9 } ] },
				} )
			)
		);
		v.fill( controlMsg( { action: 'clear-removing' } ) );
		expect( v.setStateCache.view.removingSegments ).toEqual( {} );
	} );

	test( 'a model with no removals schedules no clear timer', () => {
		jest.useFakeTimers();
		try {
			const v = makeView( 'workerstatus:view' );
			const spy = jest.spyOn( v, 'setState' );
			v.fill( modelMsg( baseModel() ) );
			spy.mockClear();
			jest.advanceTimersByTime( 1000 );
			expect( spy ).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	} );
} );

describe( 'workerstatus:view — teardown', () => {
	test( 'removeNode() clears a pending removing-clear timer (no later setState)', () => {
		jest.useFakeTimers();
		try {
			const v = makeView( 'workerstatus:view' );
			v.fill(
				modelMsg(
					baseModel( {
						removingSegments: {
							'firehose.p0': [ { id: 1, size: 9 } ],
						},
					} )
				)
			);
			const spy = jest.spyOn( v, 'setState' );
			v.removeNode();
			jest.advanceTimersByTime( 400 );
			expect( spy ).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'removeNode() is safe when no timer is pending', () => {
		const v = makeView( 'workerstatus:view' );
		expect( () => v.removeNode() ).not.toThrow();
	} );
} );

describe( 'workerstatus:view — node wiring', () => {
	test( 'names the node', () => {
		const v = makeView( 'workerstatus:view' );
		expect( v.name ).toBe( 'workerstatus:view' );
	} );

	test( 'fill increments the node counter so the overlay shows throughput', () => {
		const v = makeView( 'workerstatus:view' );
		expect( v.counter ).toBe( 0 );
		v.fill( modelMsg( {} ) );
		v.fill( modelMsg( {} ) );
		expect( v.counter ).toBe( 2 );
	} );

	test( 'declares has_target:false (terminal receiver — no out-port)', () => {
		expect( WorkerStatusViewNode.nodeSchema().has_target ).toBe( false );
	} );
} );

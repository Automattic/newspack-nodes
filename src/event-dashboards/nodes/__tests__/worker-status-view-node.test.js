/**
 * workerstatus:view tests — the render-state node React reads via
 * useNodeState('workerstatus:view','view').
 *
 * Post-migration to substrate `_http`, the view follows the canonical
 * serversView pattern:
 *   - awaited verbs (restart) stash a `{ resolve, reject }` in the view's
 *     `pending` Map keyed by `message[ID]`; the reply lands at the view
 *     (FROM=view → reply routes TO=view) and the view settles the Promise.
 *   - pending-matched TM_ERROR rejects the Promise but does NOT pollute the
 *     view-model's global `error` field — that surface is for un-correlated
 *     errors (e.g. broadcasts).
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

describe( 'workerstatus:view — un-correlated TM_ERROR (global error)', () => {
	test( 'an un-correlated TM_ERROR (no matching pending) surfaces into view.error', () => {
		const v = makeView( 'workerstatus:view' );
		v.fill( modelMsg( baseModel() ) );
		// No pending entry for this id → falls to the global error path.
		v.fill( restartErrorReply( 'never-stashed', 'broadcast failure' ) );
		expect( v.setStateCache.view.error ).toBe( 'broadcast failure' );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );
} );

describe( 'workerstatus:view — removing-segment animation', () => {
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
	test( 'close() clears a pending removing-clear timer (no later setState)', () => {
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
			v.close();
			jest.advanceTimersByTime( 400 );
			expect( spy ).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'close() is safe when no timer is pending', () => {
		const v = makeView( 'workerstatus:view' );
		expect( () => v.close() ).not.toThrow();
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

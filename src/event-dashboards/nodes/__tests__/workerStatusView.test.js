/**
 * workerstatus:view tests — the render-state node React reads via
 * useNodeState('workerstatus:view','view').
 *
 * Worker Status updates per-poll (no high-frequency rAF), so EVERYTHING goes
 * through the low-frequency setState('view', model) path. The node also owns the
 * segment slide-out animation timer: storing a model with non-empty
 * removingSegments schedules a 400ms self-fill of `clear-removing` that blanks
 * them and republishes.
 */

import { VALUE, TYPE, TM_STRUCT, newMessage } from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { createWorkerStatusView } from '../workerStatusView';

// setName registers in the per-process Core registry; clear it between tests so
// re-creating the same-named node doesn't collide (matches the sibling tests).
beforeEach( () => Core.reset() );

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

const baseModel = ( overrides = {} ) => ( {
	workers: [],
	supervisor: null,
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
		const v = createWorkerStatusView( 'workerstatus:view' );
		const model = baseModel( {
			workers: [ { type: 'firehose-workers' } ],
		} );
		v.fill( modelMsg( model ) );
		expect( v.setStateCache.view ).toEqual( model );
	} );

	test( 'a later model replaces the published view', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		v.fill( modelMsg( baseModel( { currentTime: 1 } ) ) );
		v.fill( modelMsg( baseModel( { currentTime: 2 } ) ) );
		expect( v.setStateCache.view.currentTime ).toBe( 2 );
	} );
} );

describe( 'workerstatus:view — error control', () => {
	test( 'an error control sets error on the published model', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		v.fill( modelMsg( baseModel() ) );
		v.fill(
			controlMsg( { action: 'error', error: 'Server disconnected' } )
		);
		expect( v.setStateCache.view.error ).toBe( 'Server disconnected' );
	} );

	test( 'a fresh model clears a previously-set error', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		v.fill( controlMsg( { action: 'error', error: 'boom' } ) );
		v.fill( modelMsg( baseModel( { error: null } ) ) );
		expect( v.setStateCache.view.error ).toBeNull();
	} );

	test( 'an error before any model still publishes a loading-cleared view', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		v.fill( controlMsg( { action: 'error', error: 'down' } ) );
		expect( v.setStateCache.view.error ).toBe( 'down' );
		expect( v.setStateCache.view.loading ).toBe( false );
	} );
} );

describe( 'workerstatus:view — removing-segment animation', () => {
	test( 'a model with removingSegments schedules a 400ms clear that blanks them', () => {
		jest.useFakeTimers();
		try {
			const v = createWorkerStatusView( 'workerstatus:view' );
			v.fill(
				modelMsg(
					baseModel( {
						removingSegments: {
							'firehose-0': [ { id: 1, size: 9 } ],
						},
					} )
				)
			);
			// Present immediately for the slide-out animation.
			expect( v.setStateCache.view.removingSegments ).toEqual( {
				'firehose-0': [ { id: 1, size: 9 } ],
			} );
			jest.advanceTimersByTime( 400 );
			// Blanked after the animation window.
			expect( v.setStateCache.view.removingSegments ).toEqual( {} );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'a clear-removing control blanks removingSegments and republishes', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		v.fill(
			modelMsg(
				baseModel( {
					removingSegments: { 'firehose-0': [ { id: 1, size: 9 } ] },
				} )
			)
		);
		v.fill( controlMsg( { action: 'clear-removing' } ) );
		expect( v.setStateCache.view.removingSegments ).toEqual( {} );
	} );

	test( 'a model with no removals schedules no clear timer', () => {
		jest.useFakeTimers();
		try {
			const v = createWorkerStatusView( 'workerstatus:view' );
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
			const v = createWorkerStatusView( 'workerstatus:view' );
			v.fill(
				modelMsg(
					baseModel( {
						removingSegments: {
							'firehose-0': [ { id: 1, size: 9 } ],
						},
					} )
				)
			);
			const spy = jest.spyOn( v, 'setState' );
			// Teardown before the 400ms window elapses.
			v.close();
			jest.advanceTimersByTime( 400 );
			expect( spy ).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'close() is safe when no timer is pending', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		expect( () => v.close() ).not.toThrow();
	} );
} );

describe( 'workerstatus:view — node wiring', () => {
	test( 'names the node', () => {
		const v = createWorkerStatusView( 'workerstatus:view' );
		expect( v.name ).toBe( 'workerstatus:view' );
	} );
} );

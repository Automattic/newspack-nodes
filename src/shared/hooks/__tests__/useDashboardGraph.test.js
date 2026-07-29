/**
 * useDashboardGraph tests — the shared mount + poll skeleton every poll-based
 * dashboard hook clips onto. It owns the exospine mount, the `_http` I/O
 * boundary (CommandClient seam), the immediate + page-visibility-gated interval
 * poll, and the `interpreterRef` handle consumers fire awaited verbs against.
 */

import { renderHook, act } from '@testing-library/react';
import { Core, useNodeState } from '@newspack-nodes/runtime';

import { useDashboardGraph, makeOpId } from '../useDashboardGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const VIEW = 'test:view';
const REFRESH_MS = 4321;
const RETIMED_REFRESH_MS = 8765;

function setVisibility( state ) {
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => state,
	} );
	document.dispatchEvent( new Event( 'visibilitychange' ) );
}

beforeEach( () => {
	Core.reset();
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		get: () => 'visible',
	} );
} );

afterEach( () => {
	jest.restoreAllMocks();
} );

describe( 'useDashboardGraph — mount', () => {
	test( 'mounts the backbone + `_http`, and calls mountNodes with the interpreter', () => {
		let seen = null;
		const mountNodes = ( interpreter ) => {
			seen = interpreter;
			interpreter.makeNode( 'Tee', VIEW );
		};
		renderHook( () => useDashboardGraph( { mountNodes, poll: () => {} } ) );

		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		expect( seen ).toBe( interpreter );
		// `_http` and the consumer's view node both sink into the interpreter.
		expect( Core.node( HTTP ).sink ).toBe( interpreter );
		expect( Core.node( VIEW ).sink ).toBe( interpreter );
	} );

	test( '`_http` gets the injected commandClient as its client', () => {
		const client = { buildMessage: () => {}, postBatch: () => {} };
		renderHook( () =>
			useDashboardGraph( {
				mountNodes: () => {},
				poll: () => {},
				commandClient: client,
			} )
		);
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'returns an interpreterRef pointing at the mounted interpreter', () => {
		const { result } = renderHook( () =>
			useDashboardGraph( { mountNodes: () => {}, poll: () => {} } )
		);
		expect( result.current.interpreterRef.current ).toBe(
			Core.node( INTERPRETER )
		);
	} );

	test( 'returns a lastPollRef stamped to the most recent poll fire', () => {
		const before = Date.now();
		const { result } = renderHook( () =>
			useDashboardGraph( { mountNodes: () => {}, poll: () => {} } )
		);
		// The mount poll fired, so the freshness clock is stamped (>= mount).
		expect( result.current.lastPollRef.current ).toBeGreaterThanOrEqual(
			before
		);
	} );

	test( 'nulls interpreterRef on unmount (cleanup)', () => {
		const { result, unmount } = renderHook( () =>
			useDashboardGraph( { mountNodes: () => {}, poll: () => {} } )
		);
		expect( result.current.interpreterRef.current ).toBeTruthy();
		unmount();
		expect( result.current.interpreterRef.current ).toBeNull();
	} );
} );

describe( 'useDashboardGraph — poll', () => {
	test( 'fires one immediate poll on mount with the interpreter', () => {
		const calls = [];
		renderHook( () =>
			useDashboardGraph( {
				mountNodes: () => {},
				poll: ( i ) => calls.push( i ),
			} )
		);
		expect( calls.length ).toBe( 1 );
		expect( calls[ 0 ] ).toBe( Core.node( INTERPRETER ) );
	} );

	test( 'polls again on each interval tick while page-visible', () => {
		jest.useFakeTimers();
		try {
			const calls = [];
			renderHook( () =>
				useDashboardGraph( {
					mountNodes: () => {},
					poll: ( i ) => calls.push( i ),
					refreshMs: REFRESH_MS,
				} )
			);
			const afterMount = calls.length;
			expect( afterMount ).toBe( 1 );
			act( () => {
				jest.advanceTimersByTime( REFRESH_MS );
			} );
			expect( calls.length ).toBe( afterMount + 1 );
			act( () => {
				jest.advanceTimersByTime( REFRESH_MS );
			} );
			expect( calls.length ).toBe( afterMount + 2 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'does not poll while initially hidden, then polls immediately on becoming visible', () => {
		setVisibility( 'hidden' );
		jest.useFakeTimers();
		try {
			const calls = [];
			renderHook( () =>
				useDashboardGraph( {
					mountNodes: () => {},
					poll: ( i ) => calls.push( i ),
					refreshMs: REFRESH_MS,
				} )
			);
			expect( calls ).toHaveLength( 0 );
			act( () => {
				jest.advanceTimersByTime( REFRESH_MS * 3 );
			} );
			expect( calls ).toHaveLength( 0 );

			act( () => {
				setVisibility( 'visible' );
			} );
			expect( calls ).toHaveLength( 1 );
			expect( calls[ 0 ] ).toBe( Core.node( INTERPRETER ) );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'does not double-poll when real visibility reconciles false to true on mount', () => {
		jest.useFakeTimers();
		try {
			const calls = [];
			renderHook( () =>
				useDashboardGraph( {
					mountNodes: () => {},
					poll: ( i ) => calls.push( i ),
					refreshMs: REFRESH_MS,
				} )
			);
			expect( calls ).toHaveLength( 1 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 're-times the interval and polls once immediately when refreshMs changes', () => {
		jest.useFakeTimers();
		try {
			const calls = [];
			const { rerender } = renderHook(
				( { refreshMs } ) =>
					useDashboardGraph( {
						mountNodes: () => {},
						poll: ( i ) => calls.push( i ),
						refreshMs,
					} ),
				{ initialProps: { refreshMs: REFRESH_MS } }
			);
			expect( calls ).toHaveLength( 1 );

			act( () => {
				jest.advanceTimersByTime( REFRESH_MS - 1 );
				rerender( { refreshMs: RETIMED_REFRESH_MS } );
			} );
			expect( calls ).toHaveLength( 2 );

			act( () => {
				jest.advanceTimersByTime( REFRESH_MS );
			} );
			expect( calls ).toHaveLength( 2 );

			act( () => {
				jest.advanceTimersByTime( RETIMED_REFRESH_MS - REFRESH_MS );
			} );
			expect( calls ).toHaveLength( 3 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'keeps interval polls paused without re-timing the interval', () => {
		jest.useFakeTimers();
		try {
			const calls = [];
			const { rerender } = renderHook(
				( { paused } ) =>
					useDashboardGraph( {
						mountNodes: () => {},
						poll: ( i ) => calls.push( i ),
						paused,
						refreshMs: REFRESH_MS,
					} ),
				{ initialProps: { paused: false } }
			);
			expect( calls ).toHaveLength( 1 );

			act( () => {
				rerender( { paused: true } );
			} );
			act( () => {
				jest.advanceTimersByTime( REFRESH_MS );
			} );
			expect( calls ).toHaveLength( 1 );

			act( () => {
				rerender( { paused: false } );
			} );
			act( () => {
				jest.advanceTimersByTime( REFRESH_MS );
			} );
			expect( calls ).toHaveLength( 2 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'polls once and rebinds consumer node state after a visible graph rebuild', () => {
		jest.useFakeTimers();
		try {
			const calls = [];
			const { result } = renderHook( () => {
				const graph = useDashboardGraph( {
					mountNodes: ( interpreter ) =>
						interpreter.makeNode( 'Tee', VIEW ),
					poll: ( i ) => calls.push( i ),
					refreshMs: REFRESH_MS,
				} );
				const view = useNodeState( VIEW, 'view' );
				return { ...graph, view };
			} );
			expect( calls ).toHaveLength( 1 );

			const firstView = Core.node( VIEW );
			act( () => {
				firstView.setState( 'view', 'before-rebuild' );
			} );
			expect( result.current.view ).toBe( 'before-rebuild' );

			calls.length = 0;
			act( () => {
				Core.bumpGraphGeneration();
			} );

			const rebuiltView = Core.node( VIEW );
			expect( rebuiltView ).not.toBe( firstView );
			expect( calls ).toHaveLength( 1 );
			expect( calls[ 0 ] ).toBe( Core.node( INTERPRETER ) );

			act( () => {
				rebuiltView.setState( 'view', 'after-rebuild' );
			} );
			expect( result.current.view ).toBe( 'after-rebuild' );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'runs the mountNodes-returned cleanup on unmount', () => {
		const order = [];
		const mountNodes = () => () => order.push( 'cleanup' );
		const { result, unmount } = renderHook( () =>
			useDashboardGraph( { mountNodes, poll: () => {} } )
		);
		expect( result.current.interpreterRef.current ).toBeTruthy();
		unmount();
		expect( order ).toEqual( [ 'cleanup' ] );
		expect( result.current.interpreterRef.current ).toBeNull();
	} );
} );

describe( 'makeOpId', () => {
	test( 'produces unique, prefixed, monotonic ids', () => {
		const a = makeOpId( 'pfx' );
		const b = makeOpId( 'pfx' );
		expect( a ).toMatch( /^pfx-\d+-\d+$/ );
		expect( a ).not.toBe( b );
	} );
} );

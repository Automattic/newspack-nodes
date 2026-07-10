/**
 * useDashboardGraph tests — the shared mount + poll skeleton every poll-based
 * dashboard hook clips onto. It owns the exospine mount, the `_http` I/O
 * boundary (CommandClient seam), the immediate + page-visibility-gated interval
 * poll, and the `interpreterRef` handle consumers fire awaited verbs against.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '@newspack-nodes/runtime';

// global (not a module-scoped var) so jest.mock's hoisted factory may read it.
global.__pageVisible = true;
jest.mock( '../usePageVisibility', () => ( {
	__esModule: true,
	default: () => global.__pageVisible,
} ) );

import { useDashboardGraph, makeOpId } from '../useDashboardGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const VIEW = 'test:view';

beforeEach( () => {
	global.__pageVisible = true;
	Core.reset();
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
					refreshMs: 4000,
				} )
			);
			const afterMount = calls.length;
			expect( afterMount ).toBe( 1 );
			act( () => {
				jest.advanceTimersByTime( 4000 );
			} );
			expect( calls.length ).toBe( afterMount + 1 );
			act( () => {
				jest.advanceTimersByTime( 4000 );
			} );
			expect( calls.length ).toBe( afterMount + 2 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'does not poll on interval while the page is hidden', () => {
		global.__pageVisible = false;
		jest.useFakeTimers();
		try {
			const calls = [];
			renderHook( () =>
				useDashboardGraph( {
					mountNodes: () => {},
					poll: ( i ) => calls.push( i ),
					refreshMs: 4000,
				} )
			);
			// The immediate mount poll still fires; the interval does not.
			const baseline = calls.length;
			act( () => {
				jest.advanceTimersByTime( 12000 );
			} );
			expect( calls.length ).toBe( baseline );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'fires an immediate poll when the page becomes visible again (no full-interval stale gap)', () => {
		global.__pageVisible = false;
		jest.useFakeTimers();
		try {
			const calls = [];
			const { rerender } = renderHook( () =>
				useDashboardGraph( {
					mountNodes: () => {},
					poll: ( i ) => calls.push( i ),
					refreshMs: 4000,
				} )
			);
			// Hidden: drain any mount poll into the baseline.
			const hiddenBaseline = calls.length;

			// Becoming visible must refresh immediately, no tick wait.
			global.__pageVisible = true;
			act( () => {
				rerender();
			} );
			expect( calls.length ).toBe( hiddenBaseline + 1 );
		} finally {
			jest.useRealTimers();
		}
	} );

	test( 'does not double-poll on initial mount (mount poll + visibility poll)', () => {
		jest.useFakeTimers();
		try {
			const calls = [];
			renderHook( () =>
				useDashboardGraph( {
					mountNodes: () => {},
					poll: ( i ) => calls.push( i ),
					refreshMs: 4000,
				} )
			);
			// Exactly ONE poll on mount; visibility effect adds no second poll.
			expect( calls.length ).toBe( 1 );
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

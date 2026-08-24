/**
 * Tests for useContainerRefit — the observe-or-window refit every chart and
 * canvas in the tree was hand-rolling.
 */

import { renderHook, act } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { useContainerRefit } from '../useContainerRefit';

let observerCb = null;
let disconnected = false;
let constructed = 0;

/**
 * jsdom has no layout, so a box has to be stubbed to be measurable.
 *
 * @param {number} w Content width.
 * @param {number} h Content height.
 * @return {Object} A div reporting that box.
 */
const sized = ( w, h ) => {
	const el = document.createElement( 'div' );
	Object.defineProperty( el, 'clientWidth', {
		value: w,
		configurable: true,
	} );
	Object.defineProperty( el, 'clientHeight', {
		value: h,
		configurable: true,
	} );
	return el;
};

const box = ( width, height = 100 ) => [ { contentRect: { width, height } } ];

/**
 * A ResizeObserver that behaves like the spec: it delivers one observation on
 * observe(), reporting the box it was given at bind time.
 *
 * @param {?Array} initial Entries for the observe() observation; null for an
 *                         element whose box is already 0x0, which the spec
 *                         seeds as lastReportedSize and so reports nothing.
 */
const withObserver = ( initial = box( 600, 200 ) ) => {
	observerCb = null;
	disconnected = false;
	constructed = 0;
	global.ResizeObserver = class {
		constructor( cb ) {
			observerCb = cb;
			constructed++;
		}
		observe() {
			if ( initial ) {
				observerCb( initial );
			}
		}
		disconnect() {
			disconnected = true;
		}
	};
};

const mount = ( cb, ms, el = sized( 600, 200 ) ) =>
	renderHook(
		( { fn } ) => {
			const ref = useRef( el );
			useContainerRefit( ref, fn, [], ms );
			return ref;
		},
		{ initialProps: { fn: cb } }
	);

describe( 'useContainerRefit', () => {
	beforeEach( () => {
		jest.useFakeTimers();
		withObserver();
	} );
	afterEach( () => {
		jest.useRealTimers();
	} );

	it( 'ignores the observation reporting the box already drawn', () => {
		// Otherwise every mount and every dep change pays a full rebuild
		// 150ms after the build effect already drew the chart.
		const cb = jest.fn();
		mount( cb );
		act( () => jest.advanceTimersByTime( 400 ) );
		expect( cb ).toHaveBeenCalledTimes( 0 );
	} );

	it( 'refits an element revealed from zero, which sends no observation on observe()', () => {
		// The spec seeds lastReportedSize to 0x0, so a hidden or unlaid element
		// gets nothing on observe(). Counting observations would swallow the
		// 0-to-N that follows, freezing the chart at its fallback width.
		withObserver( null );
		const cb = jest.fn();
		mount( cb, undefined, sized( 0, 0 ) );
		act( () => {
			observerCb( box( 740 ) );
			jest.advanceTimersByTime( 400 );
		} );
		expect( cb ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'ignores a repeat of the box it last reported, not just the seed', () => {
		// TopologyConsole passes debounceMs 0 and sets a height its own
		// callback feeds back into the observed element. With only the seed
		// guarded, an unchanged box re-enters the callback every observation:
		// "ResizeObserver loop completed with undelivered notifications".
		const cb = jest.fn();
		mount( cb, 0 );
		act( () => observerCb( box( 741, 255 ) ) );
		act( () => observerCb( box( 741, 255 ) ) );
		expect( cb ).toHaveBeenCalledTimes( 1 );
		// A real change still gets through.
		act( () => observerCb( box( 741, 291 ) ) );
		expect( cb ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'coalesces a burst of differing boxes into one call', () => {
		const cb = jest.fn();
		mount( cb );
		act( () => {
			for ( let i = 1; i <= 9; i++ ) {
				observerCb( box( 300 + i ) );
			}
			jest.advanceTimersByTime( 400 );
		} );
		expect( cb ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'calls the CURRENT callback, not the one bound at mount', () => {
		// FlameGraph passes an inline arrow closing over its data; without the
		// callback ref it would refit against a stale closure.
		const first = jest.fn();
		const second = jest.fn();
		const { rerender } = mount( first );
		act( () => rerender( { fn: second } ) );
		act( () => {
			observerCb( box( 512 ) );
			jest.advanceTimersByTime( 400 );
		} );
		expect( first ).toHaveBeenCalledTimes( 0 );
		expect( second ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'disconnects the observer on unmount', () => {
		const { unmount } = mount( jest.fn() );
		unmount();
		expect( disconnected ).toBe( true );
	} );

	it( 'falls back to a debounced window listener without ResizeObserver', () => {
		const saved = global.ResizeObserver;
		delete global.ResizeObserver;
		const remove = jest.spyOn( window, 'removeEventListener' );
		try {
			const cb = jest.fn();
			const { unmount } = mount( cb );
			act( () => {
				for ( let i = 0; i < 4; i++ ) {
					window.dispatchEvent( new Event( 'resize' ) );
				}
				jest.advanceTimersByTime( 400 );
			} );
			expect( cb ).toHaveBeenCalledTimes( 1 );

			// Cleared first, so only the unmount removal can satisfy this.
			remove.mockClear();
			unmount();
			expect( remove ).toHaveBeenCalledWith(
				'resize',
				expect.any( Function )
			);
		} finally {
			remove.mockRestore();
			global.ResizeObserver = saved;
		}
	} );

	it( 'honours a caller-supplied debounce', () => {
		const cb = jest.fn();
		mount( cb, 500 );
		act( () => {
			observerCb( box( 640 ) );
			jest.advanceTimersByTime( 400 );
		} );
		expect( cb ).toHaveBeenCalledTimes( 0 );
		act( () => jest.advanceTimersByTime( 200 ) );
		expect( cb ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'runs a zero-debounce measurement in the observation, before paint', () => {
		const cb = jest.fn();
		mount( cb, 0 );
		act( () => observerCb( box( 900 ) ) );
		expect( cb ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'compares the CONTENT box, so padding does not read as a resize', () => {
		// clientWidth is the padding box and is integer-rounded; contentRect
		// is neither. Seeding from one and comparing against the other made
		// the seed unmatchable, and the redundant rebuild ran anyway.
		const el = sized( 620, 206 );
		el.style.padding = '3px 10px';
		withObserver( box( 600, 200 ) );
		const cb = jest.fn();
		mount( cb, undefined, el );
		act( () => jest.advanceTimersByTime( 400 ) );
		expect( cb ).toHaveBeenCalledTimes( 0 );
	} );

	it( 'treats a sub-pixel difference as the same box', () => {
		// `clientWidth` is integer-rounded and `contentRect` is not, so a real
		// browser seeds 617 against an observation of 616.664. Comparing them
		// exactly is what made the seed unmatchable in the first place.
		const el = sized( 600, 200 );
		withObserver( box( 599.6, 200.4 ) );
		const cb = jest.fn();
		mount( cb, undefined, el );
		act( () => jest.advanceTimersByTime( 400 ) );
		expect( cb ).toHaveBeenCalledTimes( 0 );
	} );

	it( 'clamps a content box that padding drives negative', () => {
		// `clientWidth` already excludes the scrollbar gutter, so a padded
		// scrolling panel mid-animation measures narrower than its own
		// padding. Layout reports 0; an unclamped -5 matches no observation.
		const el = sized( 15, 40 );
		el.style.padding = '0 10px';
		withObserver( box( 0, 40 ) );
		const cb = jest.fn();
		mount( cb, undefined, el );
		act( () => jest.advanceTimersByTime( 400 ) );
		expect( cb ).toHaveBeenCalledTimes( 0 );
	} );

	it( 'binds when a dep change makes a previously-absent element appear', () => {
		// A chart that renders null before its data arrives has no container
		// at first bind, so the hook binds nothing. Only a dep change re-runs
		// the effect — which is why such callers MUST list one, and why
		// "the callback is in a ref so deps are redundant" is wrong for them.
		let el = null;
		const cb = jest.fn();
		const { rerender } = renderHook(
			( { ready } ) => useContainerRefit( () => el, cb, [ ready ] ),
			{ initialProps: { ready: false } }
		);
		expect( constructed ).toBe( 0 );

		el = sized( 480, 260 );
		act( () => rerender( { ready: true } ) );
		expect( constructed ).toBe( 1 );

		act( () => {
			observerCb( box( 700 ) );
			jest.advanceTimersByTime( 400 );
		} );
		expect( cb ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'keeps one observer across re-renders when given an inline resolver', () => {
		// An inline arrow changes identity every render; listing it as a dep
		// tore the observer down and rebuilt it each time, re-seeding with it.
		const el = sized( 400, 300 );
		const { rerender } = renderHook(
			( { fn } ) => useContainerRefit( () => el, fn, [] ),
			{ initialProps: { fn: jest.fn() } }
		);
		act( () => rerender( { fn: jest.fn() } ) );
		act( () => rerender( { fn: jest.fn() } ) );
		expect( constructed ).toBe( 1 );
	} );

	it( 'accepts a resolver for an element reached through the DOM', () => {
		const el = sized( 300, 150 );
		const cb = jest.fn();
		renderHook( () => useContainerRefit( () => el, cb, [] ) );
		act( () => {
			observerCb( box( 480 ) );
			jest.advanceTimersByTime( 400 );
		} );
		expect( cb ).toHaveBeenCalledTimes( 1 );
	} );
} );

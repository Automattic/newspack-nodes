import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
/**
 * useTimeChart tests — pure helpers, constants, and the render/resize
 * lifecycle. d3 is mocked (the substrate doesn't ship it).
 */

jest.mock(
	'd3',
	() => ( {
		bisector: () => ( { left: () => 0 } ),
		pointer: () => [ 0, 0 ],
	} ),
	{ virtual: true }
);

import { renderHook, act } from '@testing-library/react';
import {
	BUCKET_MINUTES,
	BUCKET_SECONDS,
	BUCKET_MS,
	NUM_BUCKETS,
	DEFAULT_RETENTION_SECONDS,
	MARGIN,
	PALETTE,
	buildTimeSlots,
	drawLegend,
	formatXTick,
	setupTooltip,
	useTimeChart,
} from '../useTimeChart';

// jsdom has no ResizeObserver; capture its callback to fire a synthetic resize.
let resizeObserverCb = null;
let resizeObserverDisconnected = false;
global.ResizeObserver = class {
	constructor( cb ) {
		resizeObserverCb = cb;
	}
	observe() {
		// The spec seeds lastReportedSize to 0x0 and jsdom lays nothing
		// out, so a real observer would deliver nothing here.
	}
	disconnect() {
		resizeObserverDisconnected = true;
	}
};

// Fluent chain mock — every d3 method returns the same object.
const makeFluent = () => {
	const obj = {};
	obj.append = jest.fn( () => obj );
	obj.attr = jest.fn( () => obj );
	obj.text = jest.fn( () => obj );
	obj.style = jest.fn( () => obj );
	obj.on = jest.fn( () => obj );
	obj.handlers = {};
	// Record .on registrations so tests can drive them.
	obj.on.mockImplementation( ( type, fn ) => {
		obj.handlers[ type ] = fn;
		return obj;
	} );
	return obj;
};

describe( 'useTimeChart constants', () => {
	it( 'exposes the 5-minute bucket pitch', () => {
		expect( BUCKET_MINUTES ).toBe( 5 );
		expect( BUCKET_SECONDS ).toBe( 300 );
		expect( BUCKET_MS ).toBe( 300000 );
	} );

	it( 'derives NUM_BUCKETS from DEFAULT_RETENTION_SECONDS', () => {
		expect( NUM_BUCKETS ).toBe(
			Math.ceil( DEFAULT_RETENTION_SECONDS / BUCKET_SECONDS )
		);
	} );

	it( 'defaults the retention window without reading any host global', () => {
		// This is the substrate's canonical shared surface. It used to read
		// `window.eventLoggerDashboards`, a global only newspack-event-logger-nodes
		// sets — so every other consumer silently got the 24h fallback, and the
		// value froze at import time whatever the host later localized.
		expect( DEFAULT_RETENTION_SECONDS ).toBe( 86400 );
		expect(
			readFileSync(
				resolvePath( __dirname, '../useTimeChart.js' ),
				'utf8'
			)
		).not.toContain( 'eventLoggerDashboards' );
	} );

	it( 'MARGIN has the four expected sides', () => {
		expect( MARGIN ).toEqual( {
			top: 20,
			right: 160,
			bottom: 65,
			left: 60,
		} );
	} );

	it( 'PALETTE exposes at least the first 10 distinct colors', () => {
		expect( PALETTE.length ).toBeGreaterThanOrEqual( 10 );
		expect( new Set( PALETTE ).size ).toBe( PALETTE.length );
	} );
} );

describe( 'buildTimeSlots', () => {
	it( 'sizes the window from its argument, so a host owns its own retention', () => {
		expect( buildTimeSlots( 3600 ) ).toHaveLength( 12 );
		expect( buildTimeSlots( 7200 ) ).toHaveLength( 24 );
	} );

	it( 'returns NUM_BUCKETS entries shaped as { date, bucketKey }', () => {
		const slots = buildTimeSlots();
		expect( slots ).toHaveLength( NUM_BUCKETS );
		const sample = slots[ 0 ];
		expect( sample.date ).toBeInstanceOf( Date );
		expect( typeof sample.bucketKey ).toBe( 'string' );
		// bucketKey shape: YYYY-MM-DD-HH-MM with 5-minute floor.
		expect( sample.bucketKey ).toMatch( /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/ );
	} );

	it( 'floors minutes to the nearest 5', () => {
		const slots = buildTimeSlots();
		const last = slots[ slots.length - 1 ];
		const min = last.date.getMinutes();
		expect( min % 5 ).toBe( 0 );
	} );
} );

describe( 'formatXTick', () => {
	it( 'returns M/D HH:MM', () => {
		const d = new Date( 2026, 4, 19, 14, 7 ); // May 19 2026 14:07.
		expect( formatXTick( d ) ).toBe( '5/19 14:07' );
	} );

	it( 'pads minutes but not month/day/hour', () => {
		const d = new Date( 2026, 0, 1, 0, 5 );
		expect( formatXTick( d ) ).toBe( '1/1 0:05' );
	} );
} );

describe( 'drawLegend', () => {
	it( 'appends a group then one rect + one text per item', () => {
		const svg = makeFluent();
		drawLegend(
			svg,
			[
				{ label: 'a', color: '#f00' },
				{ label: 'a-very-long-label-that-gets-clipped', color: '#0f0' },
			],
			800
		);
		expect( svg.append ).toHaveBeenCalledWith( 'g' );
		// 1 group + 2 per item (rect + text) = 5 appends on the reused mock.
		expect( svg.append.mock.calls.length ).toBeGreaterThanOrEqual( 5 );
	} );

	it( 'truncates labels longer than 20 chars', () => {
		const svg = makeFluent();
		drawLegend(
			svg,
			[
				{
					label: 'this label is definitely over twenty chars',
					color: '#f00',
				},
			],
			800
		);
		const textCall = svg.text.mock.calls[ 0 ][ 0 ];
		expect( textCall.length ).toBe( 21 ); // 18 + '...'.
		expect( textCall.endsWith( '...' ) ).toBe( true );
	} );
} );

describe( 'setupTooltip', () => {
	const refs = ( rect = null ) => {
		const tooltipEl = document.createElement( 'div' );
		Object.defineProperty( tooltipEl, 'offsetHeight', {
			configurable: true,
			get: () => 20,
		} );
		Object.defineProperty( tooltipEl, 'offsetWidth', {
			configurable: true,
			get: () => 60,
		} );
		tooltipEl.getBoundingClientRect = () =>
			rect ?? {
				left: 0,
				right: 60,
				top: 0,
				bottom: 20,
			};
		const container = document.createElement( 'div' );
		const parent = document.createElement( 'div' );
		Object.defineProperty( parent, 'clientHeight', {
			configurable: true,
			get: () => 200,
		} );
		parent.appendChild( container );
		document.body.appendChild( parent );
		return {
			tooltipRef: { current: tooltipEl },
			lastMouseXRef: { current: null },
			containerRef: { current: container },
		};
	};

	it( 'registers mousemove + mouseleave handlers on the overlay rect', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes();
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, lastMouseXRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 100,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'val', value: 5 } ],
			tooltipRef,
			lastMouseXRef,
			containerRef,
		} );
		// Overlay registers mousemove + mouseleave.
		expect( g.handlers.mousemove ).toBeDefined();
		expect( g.handlers.mouseleave ).toBeDefined();
	} );

	it( 'showTooltip via mousemove → fills tooltip text + sets display block', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = jest.fn( ( d ) => d.getMinutes() * 10 );
		xScale.invert = jest.fn( () => dates[ 0 ] );
		const { tooltipRef, lastMouseXRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'val', value: 99 } ],
			tooltipRef,
			lastMouseXRef,
			containerRef,
		} );
		// Drive a mousemove. requestAnimationFrame defaults to next tick.
		const move = g.handlers.mousemove;
		move( {} );
		// Flush the rAF.
		return new Promise( ( resolve ) =>
			window.requestAnimationFrame( () => {
				expect( tooltipRef.current.style.display ).toBe( 'block' );
				expect( tooltipRef.current.textContent ).toMatch( /val/ );
				expect( tooltipRef.current.textContent ).toMatch( /99/ );
				resolve();
			} )
		);
	} );

	it( 'hideTooltip via mouseleave hides the tooltip', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes() * 10;
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, lastMouseXRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'a', value: 1 } ],
			tooltipRef,
			lastMouseXRef,
			containerRef,
		} );
		tooltipRef.current.style.display = 'block';
		g.handlers.mouseleave();
		expect( tooltipRef.current.style.display ).toBe( 'none' );
		expect( lastMouseXRef.current ).toBeNull();
	} );

	it( 'restores tooltip on mount when lastMouseXRef was set', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes() * 10;
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'b', value: 2 } ],
			tooltipRef,
			lastMouseXRef: { current: 10 },
			containerRef,
		} );
		expect( tooltipRef.current.style.display ).toBe( 'block' );
	} );

	it( 'keeps tooltip inside the viewport when it would overflow', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = jest.fn( ( d ) => d.getMinutes() * 10 );
		xScale.invert = jest.fn( () => dates[ 1 ] );
		const innerHeight = window.innerHeight;
		const innerWidth = window.innerWidth;
		Object.defineProperty( window, 'innerHeight', {
			configurable: true,
			value: 10,
		} );
		Object.defineProperty( window, 'innerWidth', {
			configurable: true,
			value: 10,
		} );
		const { tooltipRef, containerRef } = refs( {
			left: -5,
			right: 80,
			top: 0,
			bottom: 40,
		} );
		try {
			setupTooltip( g, {
				innerW: 200,
				innerH: 50,
				dates,
				x: xScale,
				formatEntry: () => [],
				tooltipRef,
				lastMouseXRef: { current: 25 },
				containerRef,
			} );
			expect( tooltipRef.current.style.top ).toBe( '-24px' );
			expect( tooltipRef.current.style.left ).toBe( '0px' );
		} finally {
			Object.defineProperty( window, 'innerHeight', {
				configurable: true,
				value: innerHeight,
			} );
			Object.defineProperty( window, 'innerWidth', {
				configurable: true,
				value: innerWidth,
			} );
		}
	} );

	it( 'cancels a pending tooltip frame when a newer mousemove arrives', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes() * 10;
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, lastMouseXRef, containerRef } = refs();
		const rafSpy = jest
			.spyOn( window, 'requestAnimationFrame' )
			.mockImplementation( () => 101 );
		const cancelSpy = jest
			.spyOn( window, 'cancelAnimationFrame' )
			.mockImplementation( () => {} );
		try {
			setupTooltip( g, {
				innerW: 200,
				innerH: 50,
				dates,
				x: xScale,
				formatEntry: () => [],
				tooltipRef,
				lastMouseXRef,
				containerRef,
			} );
			g.handlers.mousemove( {} );
			g.handlers.mousemove( {} );
			expect( cancelSpy ).toHaveBeenCalledWith( 101 );
			expect( rafSpy ).toHaveBeenCalledTimes( 2 );
		} finally {
			rafSpy.mockRestore();
			cancelSpy.mockRestore();
		}
	} );
} );

describe( 'useTimeChart hook lifecycle', () => {
	it( 'invokes renderFn on initial mount with three refs', () => {
		const renderFn = jest.fn();
		renderHook( () => useTimeChart( renderFn ) );
		expect( renderFn ).toHaveBeenCalledTimes( 1 );
		const args = renderFn.mock.calls[ 0 ][ 0 ];
		expect( args.containerRef ).toBeDefined();
		expect( args.tooltipRef ).toBeDefined();
		expect( args.lastMouseXRef ).toBeDefined();
	} );

	it( 'coalesces a burst of window resizes into a single render', () => {
		// Dragging a window edge fires ~60 events/sec, and every renderFn opens
		// by emptying the container: one render per event tore down and rebuilt
		// the whole SVG 60 times a second.
		jest.useFakeTimers();
		resizeObserverCb = null;
		const container = document.createElement( 'div' );
		const renderFn = jest.fn( ( refs ) => {
			refs.containerRef.current = container;
		} );
		renderHook( () => useTimeChart( renderFn ) );
		act( () => {
			for ( let i = 1; i <= 7; i++ ) {
				window.dispatchEvent( new Event( 'resize' ) );
				resizeObserverCb( [
					{ contentRect: { width: 300 + i, height: 80 } },
				] );
			}
			jest.advanceTimersByTime( 300 );
		} );
		// 1 mount render + 1 for the whole burst.
		expect( renderFn ).toHaveBeenCalledTimes( 2 );
		jest.useRealTimers();
	} );

	it( 'falls back to the window where ResizeObserver is missing', () => {
		// An embedded webview without the observer would otherwise never
		// re-fit a chart at all.
		jest.useFakeTimers();
		const saved = global.ResizeObserver;
		delete global.ResizeObserver;
		const remove = jest.spyOn( window, 'removeEventListener' );
		try {
			const container = document.createElement( 'div' );
			const renderFn = jest.fn( ( refs ) => {
				refs.containerRef.current = container;
			} );
			const { unmount } = renderHook( () => useTimeChart( renderFn ) );
			act( () => {
				for ( let i = 0; i < 5; i++ ) {
					window.dispatchEvent( new Event( 'resize' ) );
				}
				jest.advanceTimersByTime( 300 );
			} );
			// 1 mount render + 1 debounced for the burst.
			expect( renderFn ).toHaveBeenCalledTimes( 2 );

			// Cleared first, so only the unmount removal can satisfy this.
			remove.mockClear();
			unmount();
			expect( remove ).toHaveBeenCalledWith(
				'resize',
				expect.any( Function )
			);
		} finally {
			// Restore before any failure escapes, or it cascades into the rest.
			remove.mockRestore();
			global.ResizeObserver = saved;
			jest.useRealTimers();
		}
	} );

	it( 're-renders (debounced) when the container resizes, not just the window', () => {
		jest.useFakeTimers();
		resizeObserverCb = null;
		const container = document.createElement( 'div' );
		// The hook attaches its observer to whatever containerRef points at.
		const renderFn = jest.fn( ( refs ) => {
			refs.containerRef.current = container;
		} );
		renderHook( () => useTimeChart( renderFn ) );
		expect( resizeObserverCb ).toEqual( expect.any( Function ) );
		renderFn.mockClear();
		act( () => {
			resizeObserverCb( [ { contentRect: { width: 640, height: 80 } } ] );
			jest.advanceTimersByTime( 200 );
		} );
		expect( renderFn ).toHaveBeenCalledTimes( 1 );
		jest.useRealTimers();
	} );

	it( 'disconnects the container observer on unmount', () => {
		resizeObserverDisconnected = false;
		const container = document.createElement( 'div' );
		const renderFn = jest.fn( ( refs ) => {
			refs.containerRef.current = container;
		} );
		const { unmount } = renderHook( () => useTimeChart( renderFn ) );
		unmount();
		expect( resizeObserverDisconnected ).toBe( true );
	} );

	it( 'hides an open tooltip when the nearest modal content scrolls', () => {
		let refsFromHook;
		const modal = document.createElement( 'div' );
		modal.className = 'components-modal__content';
		const container = document.createElement( 'div' );
		const tooltip = document.createElement( 'div' );
		tooltip.style.display = 'block';
		modal.appendChild( container );
		document.body.appendChild( modal );

		const renderFn = jest.fn( ( refs ) => {
			refsFromHook = refs;
			refs.containerRef.current = container;
			refs.tooltipRef.current = tooltip;
			refs.lastMouseXRef.current = 12;
		} );
		const { unmount } = renderHook( () => useTimeChart( renderFn ) );
		modal.dispatchEvent( new Event( 'scroll' ) );
		expect( refsFromHook.lastMouseXRef.current ).toBeNull();
		expect( tooltip.style.display ).toBe( 'none' );

		const spy = jest.spyOn( modal, 'removeEventListener' );
		unmount();
		expect( spy ).toHaveBeenCalledWith( 'scroll', expect.any( Function ) );
		spy.mockRestore();
		modal.remove();
	} );
} );

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
/**
 * useTimeChart tests — pure helpers, constants, and the render/resize
 * lifecycle, against real d3.
 */

import { renderHook, act } from '@testing-library/react';
import {
	BUCKET_MINUTES,
	BUCKET_SECONDS,
	BUCKET_MS,
	NUM_BUCKETS,
	DEFAULT_RETENTION_SECONDS,
	MARGIN,
	PALETTE,
	chartColor,
	nameHash,
	buildTimeSlots,
	formatXTick,
	setupTooltip,
	shadeSlots,
	useTimeChart,
} from '../useTimeChart';
import { clientBox as measureClientBox } from '../../utils/viewportChrome';

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
		// This is the substrate's canonical shared surface, so it must not
		// read `window.eventLoggerDashboards`, a global only
		// newspack-event-logger-nodes sets.
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
			right: 20,
			bottom: 65,
			left: 72,
		} );
	} );

	it( 'PALETTE exposes at least the first 10 distinct colors', () => {
		expect( PALETTE.length ).toBeGreaterThanOrEqual( 10 );
		expect( new Set( PALETTE ).size ).toBe( PALETTE.length );
	} );

	it( 'chartColor cycles through exactly the tokens the skin declares', () => {
		const root = resolvePath( __dirname, '../../../theme/_skins.scss' );
		const declared = new Set(
			readFileSync( root, 'utf8' ).match( /--chart-\d+(?=:)/g )
		);
		const count = declared.size;
		expect( count ).toBeGreaterThan( 0 );
		// The last token, then back to the first: neither a gap nor a
		// token absent from every skin, which would drop that rank to PALETTE.
		expect( chartColor( count - 1 ) ).toMatch( `var(--chart-${ count },` );
		expect( chartColor( count ) ).toMatch( 'var(--chart-1,' );
	} );

	it( 'chartColor names the skin token for a rank, falling back to PALETTE', () => {
		expect( chartColor( 0 ) ).toBe( 'var(--chart-1, #4e79a7)' );
		// The eight tokens cycle; the twenty fallbacks cycle on their own.
		expect( chartColor( 8 ) ).toBe( `var(--chart-1, ${ PALETTE[ 8 ] })` );
		expect( chartColor( 21 ) ).toBe( `var(--chart-6, ${ PALETTE[ 1 ] })` );
	} );

	it( 'nameHash is the x31 hash of the code points, unsigned 32-bit', () => {
		expect( nameHash( 'kea-7713-a' ) ).toBe( 2742362268 );
		expect( nameHash( 'kea-7713-b' ) ).toBe( 2742362269 );
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

describe( 'setupTooltip', () => {
	// The viewport less its gutters; jsdom's own client box measures 0 x 0.
	const VIEW_W = 997;
	const VIEW_H = 757;

	/**
	 * Set the client box, the viewport less its scrollbar gutter, as its
	 * hidden fixed sentinel measures it.
	 *
	 * @param {number} width  Its right edge.
	 * @param {number} height Its bottom edge.
	 * @param {number} [left] Its left edge, past a gutter drawn on the left.
	 */
	const clientBox = ( width, height, left = 0 ) => {
		measureClientBox();
		document.querySelector(
			'.newspack-nodes-client-box'
		).getBoundingClientRect = () => ( {
			left,
			top: 0,
			right: width,
			bottom: height,
		} );
	};

	beforeEach( () => clientBox( VIEW_W, VIEW_H ) );

	/**
	 * A chart's refs: the plot inside its row inside the chart, and the
	 * tooltip portaled to `<body>`, each with a viewport rectangle. The
	 * tooltip's rectangle follows its own `style.left` and `style.top`.
	 *
	 * @param {Object} [geometry]           Where it sits.
	 * @param {number} [geometry.chartTop]  The chart's top, its title's.
	 * @param {number} [geometry.rowLeft]   The row's left.
	 * @param {number} [geometry.rowBottom] The row's bottom.
	 * @param {number} [geometry.wide]      The tooltip's width.
	 * @param {number} [geometry.tall]      The tooltip's height.
	 * @return {Object} The refs setupTooltip takes.
	 */
	const refs = ( {
		chartTop = 0,
		rowLeft = 0,
		rowBottom = 230,
		wide = 60,
		tall = 20,
	} = {} ) => {
		const tooltipEl = document.createElement( 'div' );
		tooltipEl.getBoundingClientRect = () => {
			const top = parseFloat( tooltipEl.style.top || '0' );
			const left = parseFloat( tooltipEl.style.left || '0' );
			return { top, bottom: top + tall, left, right: left + wide };
		};
		const container = document.createElement( 'div' );
		const row = document.createElement( 'div' );
		row.getBoundingClientRect = jest.fn( () => ( {
			top: chartTop + 30,
			bottom: rowBottom,
			left: rowLeft,
			right: rowLeft + 400,
		} ) );
		const chart = document.createElement( 'div' );
		chart.getBoundingClientRect = jest.fn( () => ( {
			top: chartTop,
			bottom: rowBottom,
			left: rowLeft,
			right: rowLeft + 400,
		} ) );
		row.appendChild( container );
		chart.appendChild( row );
		document.body.append( chart, tooltipEl );
		return {
			tooltipRef: { current: tooltipEl },
			lastMouseXRef: { current: null },
			frameRef: { current: null },
			containerRef: { current: container },
			hideRef: { current: null },
		};
	};

	it( 'registers mousemove + mouseleave handlers on the overlay rect', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes();
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, lastMouseXRef, frameRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 100,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'val', value: 5 } ],
			tooltipRef,
			lastMouseXRef,
			frameRef,
			containerRef,
			hideRef: { current: null },
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
		const { tooltipRef, lastMouseXRef, frameRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'val', value: 99 } ],
			tooltipRef,
			lastMouseXRef,
			frameRef,
			containerRef,
			hideRef: { current: null },
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
				// Under the chart row, within the wrapper that positions it.
				expect( tooltipRef.current.style.top ).toBe( '230px' );
				resolve();
			} )
		);
	} );

	it( 'titles the tooltip in the words formatHeader gives the hovered slot', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 8 ) ];
		const xScale = ( d ) => d.getDate() * 10;
		xScale.invert = () => dates[ 1 ];
		const { tooltipRef, lastMouseXRef, frameRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'gulls', value: 41 } ],
			formatHeader: ( d ) => `Fortnight of ${ d.getDate() }`,
			tooltipRef,
			lastMouseXRef,
			frameRef,
			containerRef,
			hideRef: { current: null },
		} );
		g.handlers.mousemove( {} );
		return new Promise( ( resolve ) =>
			window.requestAnimationFrame( () => {
				expect(
					tooltipRef.current.querySelector( 'strong' ).textContent
				).toBe( 'Fortnight of 8' );
				resolve();
			} )
		);
	} );

	it( 'hideTooltip via mouseleave hides the tooltip', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes() * 10;
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, lastMouseXRef, frameRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'a', value: 1 } ],
			tooltipRef,
			lastMouseXRef,
			frameRef,
			containerRef,
			hideRef: { current: null },
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
		const { tooltipRef, frameRef, containerRef } = refs();
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [ { label: 'b', value: 2 } ],
			tooltipRef,
			lastMouseXRef: { current: 10 },
			frameRef,
			containerRef,
			hideRef: { current: null },
		} );
		expect( tooltipRef.current.style.display ).toBe( 'block' );
	} );

	it( 'keeps tooltip inside the viewport when it would overflow', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = jest.fn( ( d ) => d.getMinutes() * 10 );
		xScale.invert = jest.fn( () => dates[ 1 ] );
		clientBox( 10, 10 );
		const { tooltipRef, frameRef, containerRef } = refs( {
			rowLeft: -115,
			wide: 85,
			tall: 40,
		} );
		setupTooltip( g, {
			innerW: 200,
			innerH: 50,
			dates,
			x: xScale,
			formatEntry: () => [],
			tooltipRef,
			lastMouseXRef: { current: 25 },
			frameRef,
			containerRef,
			hideRef: { current: null },
		} );
		// Bigger than the viewport, it keeps its top and left edge in view.
		const rect = tooltipRef.current.getBoundingClientRect();
		expect( rect.top ).toBe( 0 );
		expect( rect.left ).toBe( 0 );
	} );

	describe( 'placement against what bounds the tooltip', () => {
		// Below the row, where a tooltip 263 tall fits nowhere in 311.
		const CRAMPED = { chartTop: 117, rowBottom: 330, tall: 263, view: 311 };
		const added = [];

		/**
		 * Add an element to the document, removed after the test.
		 *
		 * @param {string} tag   Tag name.
		 * @param {Object} props Properties to assign.
		 * @return {HTMLElement} The element.
		 */
		const add = ( tag, props ) => {
			const el = Object.assign( document.createElement( tag ), props );
			document.body.appendChild( el );
			added.push( el );
			return el;
		};

		/**
		 * A chart and its tooltip in a client box `view` tall.
		 *
		 * @param {Object} geometry          The refs' geometry.
		 * @param {number} geometry.view     The client box's height.
		 * @param {number} [geometry.gutter] A scrollbar gutter on the left.
		 * @return {Object} The refs setupTooltip takes.
		 */
		const placed = ( { view, gutter = 0, ...geometry } ) => {
			clientBox( VIEW_W, view, gutter );
			const r = refs( geometry );
			added.push(
				r.containerRef.current.parentElement.parentElement,
				r.tooltipRef.current
			);
			return r;
		};

		const hover = ( r ) => {
			const dates = [
				new Date( 2026, 0, 1 ),
				new Date( 2026, 0, 1, 0, 5 ),
			];
			const xScale = jest.fn( ( d ) => d.getMinutes() * 10 );
			xScale.invert = jest.fn( () => dates[ 1 ] );
			setupTooltip( makeFluent(), {
				innerW: 200,
				innerH: 50,
				dates,
				x: xScale,
				formatEntry: () => [],
				...r,
				lastMouseXRef: { current: 25 },
			} );
			return r.tooltipRef.current.getBoundingClientRect();
		};

		/**
		 * Hover a drawn chart again, its frame run at once.
		 *
		 * @param {Object} r The refs setupTooltip took.
		 * @param {Object} g The chart group it bound.
		 * @return {Object} The tooltip's rectangle.
		 */
		const rehover = ( r, g ) => {
			const frames = jest
				.spyOn( window, 'requestAnimationFrame' )
				.mockImplementation( ( fn ) => fn() );
			try {
				g.handlers.mousemove( {} );
			} finally {
				frames.mockRestore();
			}
			return r.tooltipRef.current.getBoundingClientRect();
		};

		/**
		 * Draw a chart for the refs, hovering it once.
		 *
		 * @param {Object} r The refs setupTooltip takes.
		 * @return {Object} The chart group it bound.
		 */
		const drawn = ( r ) => {
			const g = makeFluent();
			const dates = [
				new Date( 2026, 0, 1 ),
				new Date( 2026, 0, 1, 0, 5 ),
			];
			const xScale = ( d ) => d.getMinutes() * 10;
			xScale.invert = () => dates[ 1 ];
			setupTooltip( g, {
				innerW: 200,
				innerH: 50,
				dates,
				x: xScale,
				formatEntry: () => [],
				...r,
			} );
			rehover( r, g );
			return g;
		};

		/**
		 * An admin chrome element at a viewport rectangle.
		 *
		 * @param {string} id   `wpadminbar` or `adminmenuwrap`.
		 * @param {Object} rect Its left, top, right and bottom.
		 * @return {HTMLElement} The element.
		 */
		const chrome = ( id, rect ) => {
			const el = add( 'div', { id } );
			let box = rect;
			el.getBoundingClientRect = () => ( {
				...box,
				width: box.right - box.left,
				height: box.bottom - box.top,
			} );
			el.moveTo = ( next ) => {
				box = next;
			};
			return el;
		};

		afterEach( () => {
			added.splice( 0 ).forEach( ( el ) => el.remove() );
		} );

		it( 'writes viewport px: below the row, right of the cursor', () => {
			const rect = hover(
				placed( {
					chartTop: 211,
					rowLeft: 37,
					rowBottom: 419,
					tall: 50,
					view: 700,
				} )
			);

			expect( rect.top ).toBe( 419 );
			expect( rect.left ).toBe( 37 + MARGIN.left + 50 );
		} );

		it( 'flips above the chart, clear of its title, when that fits', () => {
			// Below ends at 660, past 600; above, 211 - 50 - 4, fits.
			const rect = hover(
				placed( {
					chartTop: 211,
					rowBottom: 610,
					tall: 50,
					view: 600,
				} )
			);

			expect( rect.top ).toBe( 157 );
		} );

		it( 'moves over the chart until its top is on screen', () => {
			const rect = hover( placed( CRAMPED ) );

			expect( rect.top ).toBe( 0 );
			expect( rect.bottom ).toBe( CRAMPED.tall );
		} );

		it( 'stays below, nudged up, when below overflows less than above', () => {
			// Below ends 10 past the bottom; above starts 200 above the top.
			const rect = hover(
				placed( {
					chartTop: 67,
					rowBottom: 347,
					tall: 263,
					view: 600,
				} )
			);

			expect( rect.top ).toBe( 337 );
			expect( rect.bottom ).toBe( 600 );
		} );

		it( 'measures the bottom by the client box, above the scrollbar', () => {
			// Below ends at 760: inside jsdom's innerHeight of 768, past 755.
			const rect = hover(
				placed( {
					chartTop: 400,
					rowBottom: 530,
					tall: 230,
					view: 755,
				} )
			);

			expect( rect.top ).toBe( 166 );
		} );

		it( 'keeps clear of an admin bar across the top', () => {
			chrome( 'wpadminbar', {
				top: 0,
				bottom: 37,
				left: 0,
				right: VIEW_W,
			} );

			expect( hover( placed( CRAMPED ) ).top ).toBe( 37 );
		} );

		it( 'counts an admin bar that scrolls with the page while it shows', () => {
			chrome( 'wpadminbar', {
				top: 0,
				bottom: 46,
				left: 0,
				right: VIEW_W,
			} );

			expect( hover( placed( CRAMPED ) ).top ).toBe( 46 );
		} );

		it( 'ignores an admin bar scrolled off the top', () => {
			chrome( 'wpadminbar', {
				top: -46,
				bottom: 0,
				left: 0,
				right: VIEW_W,
			} );

			expect( hover( placed( CRAMPED ) ).top ).toBe( 0 );
		} );

		it( 'ignores admin chrome that is not displayed', () => {
			chrome( 'wpadminbar', { top: 0, bottom: 0, left: 0, right: 0 } );
			chrome( 'adminmenuwrap', { top: 0, bottom: 0, left: 0, right: 0 } );
			// The cursor's column starts 100px in.
			const rowLeft = 100 - MARGIN.left - 50;

			const rect = hover( placed( { ...CRAMPED, rowLeft } ) );

			expect( rect.top ).toBe( 0 );
			expect( rect.left ).toBe( 100 );
		} );

		it( 'keeps right of an admin menu down the left', () => {
			chrome( 'adminmenuwrap', {
				top: 32,
				bottom: 700,
				left: 0,
				right: 173,
			} );
			// The cursor's column starts 100px in, under the menu.
			const rowLeft = 100 - MARGIN.left - 50;

			const rect = hover(
				placed( {
					chartTop: 100,
					rowBottom: 230,
					tall: 50,
					view: 700,
					rowLeft,
				} )
			);

			expect( rect.left ).toBe( 173 );
			expect( rect.top ).toBe( 230 );
		} );

		it( 'keeps left of an admin menu down the right, as RTL draws it', () => {
			chrome( 'adminmenuwrap', {
				top: 32,
				bottom: 700,
				left: VIEW_W - 166,
				right: VIEW_W,
			} );
			// The cursor's column starts 700px in; the menu starts at 831.
			const rowLeft = 700 - MARGIN.left - 50;

			const rect = hover(
				placed( {
					chartTop: 100,
					rowBottom: 230,
					tall: 50,
					view: 700,
					rowLeft,
					wide: 200,
				} )
			);

			// Right of the cursor runs under the menu, so it flips left.
			expect( rect.left ).toBe( 500 );
			expect( rect.right ).toBe( 700 );
		} );

		it( 'keeps clear of a scrollbar gutter drawn on the left, as RTL may', () => {
			// The cursor's column starts 5px in, inside the 15px gutter.
			const rowLeft = 5 - MARGIN.left - 50;

			const rect = hover(
				placed( {
					chartTop: 100,
					rowBottom: 230,
					tall: 50,
					view: 700,
					rowLeft,
					gutter: 15,
				} )
			);

			expect( rect.left ).toBe( 15 );
		} );

		it( 'measures the chrome, the row and the chart once a hover, and again after a hide', () => {
			const bar = chrome( 'wpadminbar', {
				top: 0,
				bottom: 37,
				left: 0,
				right: VIEW_W,
			} );
			const r = placed( CRAMPED );
			const row = r.containerRef.current.parentElement;
			const reads = () => [
				row.getBoundingClientRect.mock.calls.length,
				row.parentElement.getBoundingClientRect.mock.calls.length,
			];
			const g = drawn( r );

			bar.moveTo( { top: -37, bottom: 0, left: 0, right: VIEW_W } );

			expect( rehover( r, g ).top ).toBe( 37 );
			expect( reads() ).toEqual( [ 1, 1 ] );

			g.handlers.mouseleave();

			expect( rehover( r, g ).top ).toBe( 0 );
			expect( reads() ).toEqual( [ 2, 2 ] );
		} );
	} );

	it( 'cancels a pending tooltip frame when a newer mousemove arrives', () => {
		const g = makeFluent();
		const dates = [ new Date( 2026, 0, 1 ), new Date( 2026, 0, 1, 0, 5 ) ];
		const xScale = ( d ) => d.getMinutes() * 10;
		xScale.invert = () => dates[ 0 ];
		const { tooltipRef, lastMouseXRef, frameRef, containerRef } = refs();
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
				frameRef,
				containerRef,
				hideRef: { current: null },
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

	describe( 'slot click', () => {
		const SPAN = 300;
		const t0 = new Date( 2026, 0, 1, 13, 30 ).getTime();
		const dates = [ 0, 1, 2 ].map(
			( i ) => new Date( t0 + i * 5 * 60000 )
		);
		const xScale = ( d ) => ( ( d - t0 ) / ( 10 * 60000 ) ) * SPAN;
		xScale.invert = ( mx ) => new Date( t0 + ( mx / SPAN ) * 10 * 60000 );
		// jsdom lays out nothing, so d3.pointer() reads clientX as plot x.
		const clickAt = ( clientX, extra = {} ) => ( {
			clientX,
			currentTarget: document.createElement( 'div' ),
			...extra,
		} );
		const bind = ( onSlotClick ) => {
			const g = makeFluent();
			setupTooltip( g, {
				innerW: SPAN,
				innerH: 50,
				dates,
				x: xScale,
				formatEntry: () => [],
				...refs(),
				onSlotClick,
			} );
			return g;
		};

		it( "hands a plain click's nearest slot index to onSlotClick", () => {
			const onSlotClick = jest.fn();
			bind( onSlotClick ).handlers.click( clickAt( 290 ) );
			expect( onSlotClick ).toHaveBeenCalledTimes( 1 );
			expect( onSlotClick ).toHaveBeenCalledWith( 2, {
				additive: false,
			} );
		} );

		it.each( [ [ 'metaKey' ], [ 'ctrlKey' ] ] )(
			'reports a %s click as additive',
			( key ) => {
				const onSlotClick = jest.fn();
				bind( onSlotClick ).handlers.click(
					clickAt( 10, { [ key ]: true } )
				);
				expect( onSlotClick ).toHaveBeenCalledWith( 0, {
					additive: true,
				} );
			}
		);

		it( 'reports a shift+click as a plain click', () => {
			const onSlotClick = jest.fn();
			bind( onSlotClick ).handlers.click(
				clickAt( 290, { shiftKey: true } )
			);
			expect( onSlotClick ).toHaveBeenCalledWith( 2, {
				additive: false,
			} );
		} );

		it( 'reports nothing for the click ending a drag-selection', () => {
			const onSlotClick = jest.fn();
			const g = bind( onSlotClick );
			const spy = jest
				.spyOn( window, 'getSelection' )
				.mockReturnValue( { isCollapsed: false } );
			try {
				g.handlers.click( clickAt( 290 ) );
			} finally {
				spy.mockRestore();
			}
			expect( onSlotClick ).not.toHaveBeenCalled();
		} );

		it( 'ignores a plain click without an onSlotClick', () => {
			const g = bind( undefined );
			expect( () => g.handlers.click( clickAt( 290 ) ) ).not.toThrow();
		} );
	} );

	it( 'lights the hovered slot over the column shadeSlots shades for it', () => {
		// Each appended rect records its own attributes.
		const plot = () => {
			const rects = [];
			const append = () => {
				const rect = { attrs: {} };
				rect.attr = ( name, value ) => {
					rect.attrs[ name ] = value;
					return rect;
				};
				rect.on = () => rect;
				rects.push( rect );
				return rect;
			};
			return { g: { append }, rects };
		};
		const dates = [ 0, 1, 2 ].map(
			( i ) => new Date( 2026, 0, 1, 0, i * 5 )
		);
		const xScale = ( d ) => 37 + dates.indexOf( d ) * 113;
		xScale.invert = () => dates[ 2 ];
		const frame = { innerW: 333, innerH: 71, dates, x: xScale };
		const hover = plot();
		const { tooltipRef, frameRef, containerRef } = refs();
		setupTooltip( hover.g, {
			...frame,
			formatEntry: () => [],
			tooltipRef,
			lastMouseXRef: { current: 260 },
			frameRef,
			containerRef,
			hideRef: { current: null },
		} );
		const shaded = plot();
		shadeSlots( shaded.g, { ...frame, selectedSlots: new Set( [ 2 ] ) } );

		const column = ( { attrs } ) => [
			attrs.x,
			attrs.y,
			attrs.width,
			attrs.height,
		];
		expect( column( hover.rects[ 0 ] ) ).toEqual( [
			37 + 113 + 56.5,
			0,
			333 - 206.5,
			71,
		] );
		expect( column( shaded.rects[ 0 ] ) ).toEqual(
			column( hover.rects[ 0 ] )
		);
	} );
} );

describe( 'shadeSlots', () => {
	const shade = ( count, selected ) => {
		const rects = [];
		const g = {
			append: () => {
				const rect = { attrs: {} };
				rect.attr = ( name, value ) => {
					rect.attrs[ name ] = value;
					return rect;
				};
				rects.push( rect );
				return rect;
			},
		};
		const dates = Array.from(
			{ length: count },
			( _v, i ) => new Date( 2026, 0, 1, 0, i * 5 )
		);
		const innerW = 412;
		const x = ( d ) => ( dates.indexOf( d ) * innerW ) / ( count - 1 );
		shadeSlots( g, {
			innerW,
			innerH: 59,
			dates,
			x,
			selectedSlots: new Set( selected ),
		} );
		return rects.map( ( { attrs } ) => [ attrs.x, attrs.width ] );
	};

	it( 'butts neighbouring columns and keeps the edge ones inside the plot', () => {
		const [ [ x0, w0 ], [ x1, w1 ], [ x2, w2 ] ] = shade( 5, [ 0, 1, 2 ] );
		expect( x0 ).toBe( 0 );
		expect( x0 + w0 ).toBe( x1 );
		expect( x1 + w1 ).toBe( x2 );
		expect( w1 ).toBe( 103 );
		expect( x2 + w2 ).toBe( 257.5 );
	} );

	it( 'ends the last column at the plot edge', () => {
		const [ [ x4, w4 ] ] = shade( 5, [ 4 ] );
		expect( x4 ).toBe( 360.5 );
		expect( x4 + w4 ).toBe( 412 );
	} );

	it( 'spans the whole plot for a lone slot', () => {
		expect( shade( 1, [ 0 ] ) ).toEqual( [ [ 0, 412 ] ] );
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

	describe( 'hiding the tooltip on a scroll or a resize', () => {
		/**
		 * Mount the hook over a chart in `host`, its draw's hide a spy.
		 *
		 * @param {HTMLElement} host The chart's parent.
		 * @return {Object} The hide spy and the hook's unmount.
		 */
		const opened = ( host ) => {
			const container = document.createElement( 'div' );
			host.appendChild( container );
			const hide = jest.fn();
			const renderFn = jest.fn( ( refs ) => {
				refs.containerRef.current = container;
				refs.hideRef.current = hide;
			} );
			const { unmount } = renderHook( () => useTimeChart( renderFn ) );
			return { hide, unmount };
		};

		const scroll = ( el ) => el.dispatchEvent( new Event( 'scroll' ) );

		it( 'hides it when the modal content around the chart scrolls', () => {
			const modal = document.createElement( 'div' );
			modal.className = 'components-modal__content';
			document.body.appendChild( modal );
			const { hide, unmount } = opened( modal );

			scroll( modal );

			expect( hide ).toHaveBeenCalledTimes( 1 );
			unmount();
			modal.remove();
		} );

		it( 'hides it when any scroller around the chart scrolls, the page included', () => {
			const pane = document.createElement( 'div' );
			const inner = document.createElement( 'div' );
			pane.appendChild( inner );
			document.body.appendChild( pane );
			const { hide, unmount } = opened( inner );

			scroll( pane );
			scroll( document );

			expect( hide ).toHaveBeenCalledTimes( 2 );
			unmount();
			pane.remove();
		} );

		it( 'hides it when the window resizes', () => {
			const host = document.createElement( 'div' );
			document.body.appendChild( host );
			const { hide, unmount } = opened( host );

			window.dispatchEvent( new Event( 'resize' ) );

			expect( hide ).toHaveBeenCalledTimes( 1 );
			unmount();
			host.remove();
		} );

		it( 'leaves it open when a scroller beside the chart scrolls', () => {
			const host = document.createElement( 'div' );
			const beside = document.createElement( 'div' );
			document.body.append( host, beside );
			const { hide, unmount } = opened( host );

			scroll( beside );

			expect( hide ).not.toHaveBeenCalled();
			unmount();
			host.remove();
			beside.remove();
		} );

		it( 'stops listening once the chart unmounts', () => {
			const host = document.createElement( 'div' );
			document.body.appendChild( host );
			const { hide, unmount } = opened( host );
			unmount();

			scroll( host );
			window.dispatchEvent( new Event( 'resize' ) );

			expect( hide ).not.toHaveBeenCalled();
			host.remove();
		} );
	} );
} );

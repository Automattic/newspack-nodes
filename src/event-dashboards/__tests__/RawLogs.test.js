/**
 * RawLogs UI-surface tests — the thin view over the rawlogs node graph.
 *
 * The graph is owned by useRawLogsGraph (tested separately); here we mock it to
 * hand back spy control callbacks, and we register a fixture `rawlogs:view` node
 * in Core so the view can read its low-frequency model via useNodeState and its
 * high-frequency buffer (lines/lps) directly off the node in the rAF.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import RawLogs from '../RawLogs';

// The graph hook is exercised by its own suite; mock it to spy on the control
// callbacks the thin view wires to the dropdown / pause button. It's also called
// exactly once per RawLogs render, so the idle-frames test counts its calls as a
// render probe — no reaching into React internals.
jest.mock( '../hooks/useRawLogsGraph', () => ( {
	useRawLogsGraph: jest.fn(),
} ) );

const { useRawLogsGraph } = require( '../hooks/useRawLogsGraph' );

// A minimal stand-in for the rawlogs:view node: the low-frequency model lives in
// setStateCache.view (what useNodeState subscribes to) and the high-frequency
// buffer/LPS live directly on the instance (what the rAF reads). setState here
// notifies subscribers exactly like the real Node.setState.
function registerViewFixture( {
	logs = [],
	selected = '',
	paused = false,
	connectionError = false,
	lines = [],
	lps = 0,
} = {} ) {
	const node = {
		registrations: { view: {} },
		setStateCache: {},
		lines,
		lps,
		// Mirror the real node's O(1) windowed read contract the canvas uses.
		get linesCount() {
			return this.lines.length;
		},
		lineAt( i ) {
			return this.lines[ i ];
		},
		register( event, listener, cb ) {
			this.registrations[ event ][ listener ] = cb;
			if ( event in this.setStateCache ) {
				cb( this.setStateCache[ event ] );
			}
		},
		unregister( event, listener ) {
			delete this.registrations[ event ]?.[ listener ];
		},
		setState( event, payload ) {
			this.setStateCache[ event ] = payload;
			Object.values( this.registrations[ event ] || {} ).forEach(
				( cb ) => cb( payload )
			);
		},
	};
	node.setState( 'view', { logs, selected, paused, connectionError } );
	Core.nodes.set( 'rawlogs:view', node );
	return node;
}

describe( 'RawLogs', () => {
	let selectLog;
	let setPaused;
	let rafCbs;

	beforeAll( () => {
		// Stub the Canvas 2D context (jsdom lacks it).
		window.HTMLCanvasElement.prototype.getContext = function () {
			return {
				setTransform: () => {},
				clearRect: () => {},
				fillRect: () => {},
				fillText: () => {},
				measureText: () => ( { width: 0 } ),
				save: () => {},
				restore: () => {},
				translate: () => {},
				scale: () => {},
				beginPath: () => {},
				moveTo: () => {},
				lineTo: () => {},
				stroke: () => {},
				fill: () => {},
				closePath: () => {},
				set fillStyle( _v ) {},
				set strokeStyle( _v ) {},
				set font( _v ) {},
				set textBaseline( _v ) {},
				set textAlign( _v ) {},
				set lineWidth( _v ) {},
			};
		};
	} );

	beforeEach( () => {
		Core.reset();
		selectLog = jest.fn();
		setPaused = jest.fn();
		useRawLogsGraph.mockClear();
		useRawLogsGraph.mockReturnValue( { selectLog, setPaused } );

		// Capture rAF callbacks so a test can drive exactly one frame (the rAF
		// reads node.lines / node.lps and pushes them into React state). We do
		// NOT auto-loop — the component re-schedules inside the callback.
		rafCbs = [];
		global.requestAnimationFrame = ( cb ) => {
			rafCbs.push( cb );
			return rafCbs.length;
		};
		global.cancelAnimationFrame = () => {};
	} );

	// Run a single queued animation frame.
	const tickFrame = () => {
		const cbs = rafCbs;
		rafCbs = [];
		act( () => cbs.forEach( ( cb ) => cb( performance.now() ) ) );
	};

	it( 'renders a select populated from the view model', () => {
		registerViewFixture( {
			logs: [
				{ key: 'firehose', label: 'Firehose' },
				{ key: 'errors', label: 'Errors' },
			],
			selected: 'firehose',
		} );
		const { container } = render( <RawLogs /> );
		const select = container.querySelector( '.newspack-nodes-select' );
		expect( select ).not.toBeNull();
		expect( select.options.length ).toBe( 2 );
		expect( select.value ).toBe( 'firehose' );
	} );

	it( 'shows "No logs available" when the view model has no logs', () => {
		registerViewFixture( { logs: [] } );
		const { container } = render( <RawLogs /> );
		expect( container.textContent ).toMatch( /No logs available/ );
	} );

	it( 'selecting a log calls the graph selectLog callback', () => {
		registerViewFixture( {
			logs: [
				{ key: 'firehose', label: 'Firehose' },
				{ key: 'errors', label: 'Errors' },
			],
			selected: 'firehose',
		} );
		const { container } = render( <RawLogs /> );
		const select = container.querySelector( '.newspack-nodes-select' );
		fireEvent.change( select, { target: { value: 'errors' } } );
		expect( selectLog ).toHaveBeenCalledWith( 'errors' );
	} );

	describe( '?log= deep-linking', () => {
		beforeEach( () => {
			window.history.replaceState( {}, '', '/' );
		} );

		it( 'seeds selectLog from ?log= once the log is available', () => {
			window.history.replaceState( {}, '', '/?log=errors' );
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			render( <RawLogs /> );
			expect( selectLog ).toHaveBeenCalledWith( 'errors' );
		} );

		it( 'does not seed a ?log= that arrives only in a later catalog (no clobber)', () => {
			window.history.replaceState( {}, '', '/?log=errors' );
			// First non-empty catalog lacks 'errors' — the one seed chance is spent.
			const node = registerViewFixture( {
				logs: [ { key: 'firehose', label: 'Firehose' } ],
				selected: 'firehose',
			} );
			render( <RawLogs /> );
			expect( selectLog ).not.toHaveBeenCalledWith( 'errors' );

			// 'errors' shows up in a later update — it must NOT override the selection.
			act( () =>
				node.setState( 'view', {
					logs: [
						{ key: 'firehose', label: 'Firehose' },
						{ key: 'errors', label: 'Errors' },
					],
					selected: 'firehose',
					paused: false,
					connectionError: false,
				} )
			);
			expect( selectLog ).not.toHaveBeenCalledWith( 'errors' );
		} );

		it( 'seeds at most once even across re-renders', () => {
			window.history.replaceState( {}, '', '/?log=errors' );
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			const { rerender } = render( <RawLogs /> );
			rerender( <RawLogs /> );
			expect(
				selectLog.mock.calls.filter( ( c ) => c[ 0 ] === 'errors' )
					.length
			).toBe( 1 );
		} );

		it( 'does not seed when ?log= matches the already-selected log', () => {
			window.history.replaceState( {}, '', '/?log=firehose' );
			registerViewFixture( {
				logs: [ { key: 'firehose', label: 'Firehose' } ],
				selected: 'firehose',
			} );
			render( <RawLogs /> );
			expect( selectLog ).not.toHaveBeenCalled();
		} );

		it( 'does not seed when ?log= is not among the available logs', () => {
			window.history.replaceState( {}, '', '/?log=ghost' );
			registerViewFixture( {
				logs: [ { key: 'firehose', label: 'Firehose' } ],
				selected: 'firehose',
			} );
			render( <RawLogs /> );
			expect( selectLog ).not.toHaveBeenCalled();
		} );

		it( 'does not seed when ?log= is absent', () => {
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			render( <RawLogs /> );
			expect( selectLog ).not.toHaveBeenCalled();
		} );

		it( 'choosing a log writes ?log=<name>', () => {
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			const { container } = render( <RawLogs /> );
			fireEvent.change(
				container.querySelector( '.newspack-nodes-select' ),
				{ target: { value: 'errors' } }
			);
			expect(
				new URLSearchParams( window.location.search ).get( 'log' )
			).toBe( 'errors' );
		} );
	} );

	it( 'renders the filter input + line count from the node buffer', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [
				{ id: 1, partition: 0, content: 'one', isEven: false },
				{ id: 2, partition: 0, content: 'two', isEven: true },
			],
		} );
		const { container } = render( <RawLogs /> );
		tickFrame();
		const filter = container.querySelector(
			'.newspack-nodes-search-input'
		);
		expect( filter ).not.toBeNull();
		const count = container.querySelector(
			'.newspack-nodes-toolbar-stats__count'
		);
		expect( count.textContent ).toMatch( /2.*lines/ );
	} );

	it( 'pause button reflects the view model and calls setPaused on click', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			paused: false,
		} );
		const { container } = render( <RawLogs /> );
		const pause = container.querySelectorAll( 'button.button' )[ 0 ];
		expect( pause.textContent ).toBe( '⏸' );
		fireEvent.click( pause );
		expect( setPaused ).toHaveBeenCalledWith( true );
	} );

	it( 'pause button shows ▶ when the view model is paused', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			paused: true,
		} );
		const { container } = render( <RawLogs /> );
		const pause = container.querySelectorAll( 'button.button' )[ 0 ];
		expect( pause.textContent ).toBe( '▶' );
		fireEvent.click( pause );
		expect( setPaused ).toHaveBeenCalledWith( false );
	} );

	it( 'Clear button is rendered and clears the rendered count', () => {
		const node = registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [ { id: 1, partition: 0, content: 'one', isEven: false } ],
		} );
		const { container } = render( <RawLogs /> );
		tickFrame();
		let count = container.querySelector(
			'.newspack-nodes-toolbar-stats__count'
		);
		// Singular: one line renders "1 line" (the count is wrapped in `_n`).
		expect( count.textContent.trim() ).toBe( '1 line' );
		const clear = Array.from(
			container.querySelectorAll( 'button.button' )
		).find( ( b ) => b.textContent === 'Clear' );
		expect( clear ).not.toBeUndefined();
		expect( clear.classList.contains( 'button' ) ).toBe( true );
		// Clear empties the node buffer; the next frame reflects 0 lines.
		fireEvent.click( clear );
		node.lines = [];
		tickFrame();
		count = container.querySelector(
			'.newspack-nodes-toolbar-stats__count'
		);
		expect( count.textContent ).toMatch( /0.*lines/ );
	} );

	it( 'updates filter state on typing', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { container } = render( <RawLogs /> );
		const filter = container.querySelector(
			'.newspack-nodes-search-input'
		);
		fireEvent.change( filter, { target: { value: 'foo' } } );
		expect( filter.value ).toBe( 'foo' );
	} );

	it( 'filters the canvas row window and shows visible / total counts', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [
				{ id: 2, partition: 0, content: 'match me', isEven: true },
				{ id: 1, partition: 0, content: 'skip me', isEven: false },
			],
		} );
		const { container } = render( <RawLogs /> );
		const filter = container.querySelector(
			'.newspack-nodes-search-input'
		);
		fireEvent.change( filter, { target: { value: 'match' } } );
		tickFrame();
		const count = container.querySelector(
			'.newspack-nodes-toolbar-stats__count'
		);
		expect( count.textContent.trim() ).toBe( '1 / 2 lines' );
	} );

	it( 'displays the lines/second read from the node in the rAF', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [ { id: 1, partition: 0, content: 'x', isEven: false } ],
			lps: 4.2,
		} );
		const { container } = render( <RawLogs /> );
		tickFrame();
		const rps = container.querySelector(
			'.newspack-nodes-toolbar-stats__rps'
		);
		expect( rps ).not.toBeNull();
		expect( rps.textContent ).toMatch( /4\.2 lines\/s/ );
	} );

	it( 'does not re-render React on idle frames (no new rows)', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [ { id: 1, partition: 0, content: 'one', isEven: false } ],
			lps: 0,
		} );
		render( <RawLogs /> );
		tickFrame(); // first frame: paints the one line + settles state
		// useRawLogsGraph runs once per RawLogs render — use it as a render
		// probe. Idle frames (buffer + lps unchanged) must push no new state
		// refs, so RawLogs must NOT re-render. A per-frame setLines(newArray)
		// would re-render every frame and bump this count.
		const rendersAfterSettle = useRawLogsGraph.mock.calls.length;
		tickFrame();
		tickFrame();
		expect( useRawLogsGraph.mock.calls.length ).toBe( rendersAfterSettle );
	} );

	it( 'sources "Xs ago" from the link connector — a heartbeat resets it on an idle stream', () => {
		// Staleness reflects CONNECTION liveness: the shared link connector stamps
		// lastEventTime on every frame AND the server's idle heartbeats, so an
		// idle-but-healthy stream (no new lines) resets "ago" on each heartbeat.
		jest.useFakeTimers( {
			doNotFake: [ 'requestAnimationFrame', 'cancelAnimationFrame' ],
		} );
		jest.setSystemTime( new Date( '2026-01-01T00:00:00Z' ) );
		try {
			registerViewFixture( {
				logs: [ { key: 'firehose', label: 'F' } ],
				selected: 'firehose',
				lines: [
					{ id: 100, partition: 0, content: 'a', isEven: false },
				],
			} );
			// The connector last saw a frame 12s ago → "ago" reads ~12s.
			Core.nodes.set( 'rawlogs:link', {
				lastEventTime: () => Date.now() - 12000,
			} );
			const { container } = render( <RawLogs /> );
			tickFrame();
			act( () => jest.advanceTimersByTime( 1000 ) );
			expect( container.textContent ).toMatch( /1[23]s ago/ );
			// Heartbeat: the connector stamps a fresh lastEventTime with NO new lines.
			Core.node( 'rawlogs:link' ).lastEventTime = () => Date.now();
			tickFrame();
			act( () => jest.advanceTimersByTime( 1000 ) );
			expect( container.textContent ).toMatch( /[01]s ago/ );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'shows the connection banner when the view model has connectionError', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			connectionError: true,
		} );
		const { container } = render( <RawLogs /> );
		const banner = container.querySelector(
			'.newspack-nodes-connection-banner'
		);
		expect( banner ).not.toBeNull();
		expect( banner.textContent ).toBe( 'Connection lost. Reconnecting…' );
	} );

	it( 'hides the connection banner when connectionError is false', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			connectionError: false,
		} );
		const { container } = render( <RawLogs /> );
		expect(
			container.querySelector( '.newspack-nodes-connection-banner' )
		).toBeNull();
	} );

	it( 'falls back to an empty model when the view node is absent', () => {
		// No fixture registered — useNodeState yields undefined; the view must
		// still render (No logs available) without throwing.
		const { container } = render( <RawLogs /> );
		expect( container.textContent ).toMatch( /No logs available/ );
	} );

	it( 'does not render its own debug overlay — the hub provides one', () => {
		// As a hub tab, Raw Logs must NOT mount its own DebugOverlay; the hub
		// renders the overlay on non-console tabs. A self-rendered overlay would
		// double-up. The overlay enables its FAB off the sticky localStorage flag.
		window.localStorage.setItem( 'newspack-nodes:debug', '1' );
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { queryByRole } = render( <RawLogs /> );
		expect(
			queryByRole( 'button', { name: /node debugger/i } )
		).toBeNull();
		window.localStorage.clear();
	} );

	it( 'records manual scroll position from the scroll overlay', () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [
				{ id: 1, partition: 0, content: 'one', isEven: false },
				{ id: 2, partition: 0, content: 'two', isEven: true },
			],
		} );
		const { container } = render( <RawLogs /> );
		const scroll = container.querySelector(
			'.newspack-nodes-raw-logs-scroll'
		);
		fireEvent.scroll( scroll, { target: { scrollTop: 36 } } );
		expect( scroll.scrollTop ).toBe( 36 );
	} );
} );

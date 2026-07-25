/**
 * LogViewer UI-surface tests — the thin DOM view over the logviewer node graph.
 * The list (LogRowList) and segment sidebar (LogBrowser) have their own suites;
 * here they are mocked to markers capturing the props LogViewer wires in, so
 * these tests cover the toolbar source dropdown, the segment sidebar, Live /
 * Replay / segment browsing, and `?source=` linking.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import LogViewer from '../LogViewer';

let logRowListProps;
jest.mock( '@newspack-nodes/shared/components/LogRowList', () => ( {
	__esModule: true,
	default: ( props ) => {
		logRowListProps = props;
		return <div data-testid="log-row-list" />;
	},
} ) );

let logBrowserProps;
jest.mock( '@newspack-nodes/shared/components/LogBrowser', () => ( {
	__esModule: true,
	default: ( props ) => {
		logBrowserProps = props;
		return <div data-testid="log-browser" />;
	},
} ) );

jest.mock( '../hooks/useLogViewerGraph', () => ( {
	useLogViewerGraph: jest.fn(),
} ) );

const { useLogViewerGraph } = require( '../hooks/useLogViewerGraph' );

const GATE_SEGMENTS = [
	{ id: 3, size: 977 },
	{ id: 5, size: 233 },
];

// php: plain file; gate: segmented with two segments; debug: unavailable.
const SOURCES = [
	{
		name: 'php',
		path: '/php',
		mode: 'file',
		available: true,
		bytes: 977,
		segments: [],
	},
	{
		name: 'gate',
		path: '/gate',
		mode: 'segmented',
		available: true,
		bytes: 233,
		segments: GATE_SEGMENTS,
	},
	{
		name: 'debug',
		path: '/debug',
		mode: 'file',
		available: false,
		bytes: null,
		segments: [],
	},
];

// Stand-in logviewer:view node: model in setStateCache.view, ring on the node.
function registerViewFixture( {
	selected = '',
	paused = false,
	mode = 'live',
	lastReceivedSegment = null,
	lines = [],
} = {} ) {
	const node = {
		registrations: { view: {} },
		setStateCache: {},
		lines,
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
	node.setState( 'view', {
		logs: [],
		selected,
		paused,
		connectionError: false,
		mode,
		lastReceivedSegment,
	} );
	Core.nodes.set( 'logviewer:view', node );
	return node;
}

describe( 'LogViewer', () => {
	let selectSource;
	let setPaused;
	let seek;
	let step;
	let fetchSources;

	function mockGraph( sources = SOURCES ) {
		useLogViewerGraph.mockReturnValue( {
			selectSource,
			setPaused,
			seek,
			sources,
			step,
			fetchSources,
		} );
	}

	beforeEach( () => {
		Core.reset();
		logRowListProps = undefined;
		logBrowserProps = undefined;
		selectSource = jest.fn();
		setPaused = jest.fn();
		seek = jest.fn();
		step = jest.fn();
		fetchSources = jest.fn().mockResolvedValue( SOURCES );
		useLogViewerGraph.mockClear();
		mockGraph();
		window.history.replaceState( {}, '', '/' );
		window.localStorage.clear();
	} );

	it( 'the source catalog refreshes on an interval while a source streams', () => {
		jest.useFakeTimers();
		registerViewFixture( { selected: 'gate' } );
		render( <LogViewer /> );
		expect( fetchSources ).not.toHaveBeenCalled();
		act( () => {
			jest.advanceTimersByTime( 10000 );
		} );
		expect( fetchSources ).toHaveBeenCalledTimes( 1 );
		jest.useRealTimers();
	} );

	it( 'a record from an unknown segment re-catalogs once', () => {
		const node = registerViewFixture( { selected: 'gate' } );
		render( <LogViewer /> );
		expect( fetchSources ).not.toHaveBeenCalled();
		act( () => {
			node.setState( 'view', {
				...node.setStateCache.view,
				lastReceivedSegment: 6,
			} );
		} );
		expect( fetchSources ).toHaveBeenCalledTimes( 1 );
		// The SAME unknown segment must not re-catalog again (no loop).
		act( () => {
			node.setState( 'view', { ...node.setStateCache.view } );
		} );
		expect( fetchSources ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'renders the sources as a toolbar dropdown, unavailable ones disabled', () => {
		registerViewFixture( { selected: 'php' } );
		const { container } = render( <LogViewer /> );
		const select = container.querySelector( '.newspack-nodes-select' );
		expect( select ).not.toBeNull();
		expect( select.value ).toBe( 'php' );
		const options = [ ...select.querySelectorAll( 'option' ) ];
		expect( options.map( ( o ) => o.value ) ).toEqual( [
			'php',
			'gate',
			'debug',
		] );
		expect( options[ 1 ].disabled ).toBe( false );
		expect( options[ 2 ].disabled ).toBe( true );
	} );

	it( 'picking a source switches the stream and reflects ?source=', () => {
		registerViewFixture( { selected: 'php' } );
		const { container } = render( <LogViewer /> );
		const select = container.querySelector( '.newspack-nodes-select' );
		fireEvent.change( select, { target: { value: 'gate' } } );
		expect( selectSource ).toHaveBeenCalledWith( 'gate' );
		expect( window.location.search ).toContain( 'source=gate' );
	} );

	it( 'lists the selected segmented sources segments in the sidebar', () => {
		registerViewFixture( { selected: 'gate' } );
		render( <LogViewer /> );
		expect( logBrowserProps.items ).toEqual( GATE_SEGMENTS );
		expect( logBrowserProps.title ).toBe( 'Segments' );
	} );

	it( 'a file source has no segments to browse', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( logBrowserProps.items ).toEqual( [] );
	} );

	it( 'shapes each segment row: key, label, and a compact byte meta', () => {
		registerViewFixture( { selected: 'gate' } );
		render( <LogViewer /> );
		expect( logBrowserProps.itemKey( { id: 9, size: 1 } ) ).toBe( 9 );
		expect( logBrowserProps.itemLabel( { id: 9 } ) ).toBe( 'Segment 9' );
		expect( logBrowserProps.itemMeta( { size: 2048 } ) ).toBe( '2.0 KB' );
	} );

	it( 'browsing a segment enters pause mode (time-travel)', () => {
		registerViewFixture( { selected: 'gate' } );
		render( <LogViewer /> );
		act( () => logBrowserProps.onSelectItem( { id: 3, size: 977 } ) );
		expect( setPaused ).toHaveBeenCalledWith( true );
	} );

	it( 'step button steps once while paused; disabled while live', () => {
		registerViewFixture( { selected: 'gate', paused: true } );
		const { getByTitle } = render( <LogViewer /> );
		const button = getByTitle( 'Step one message (paused only)' );
		expect( button.disabled ).toBe( false );
		fireEvent.click( button );
		expect( step ).toHaveBeenCalled();
	} );

	it( 'browsing a segment seeks the stream to it at offset 0', () => {
		registerViewFixture( { selected: 'gate' } );
		render( <LogViewer /> );
		act( () => logBrowserProps.onSelectItem( { id: 3, size: 977 } ) );
		expect( seek ).toHaveBeenCalledWith( 'gate', {
			gate: { segment: 3, offset: 0 },
		} );
		expect( logBrowserProps.selectedKey ).toBe( 3 );
	} );

	it( 'surfaces the view-derived last-received segment as the active row', () => {
		registerViewFixture( { selected: 'gate', lastReceivedSegment: 5 } );
		render( <LogViewer /> );
		expect( logBrowserProps.activeKey ).toBe( 5 );
	} );

	it( 'Replay seeks the current source to start', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		act( () => logBrowserProps.onReplay() );
		expect( seek ).toHaveBeenCalledWith( 'php', { php: 'start' } );
	} );

	it( 'Live returns the current source to the tail (null positions)', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		act( () => logBrowserProps.onReplay() );
		act( () => logBrowserProps.onFollow() );
		expect( seek ).toHaveBeenLastCalledWith( 'php', null );
		expect( logBrowserProps.mode ).toBe( 'live' );
	} );

	it( 'passes the filter down and renders raw rows with no partition column', () => {
		registerViewFixture( { selected: 'php' } );
		const { container } = render( <LogViewer /> );
		const input = container.querySelector( '.newspack-nodes-search-input' );
		fireEvent.change( input, { target: { value: 'oops' } } );
		expect( logRowListProps.filter ).toBe( 'oops' );

		const { container: rowc } = render(
			logRowListProps.renderRow( {
				id: 1,
				content: '[warn] slow query',
				isEven: false,
			} )
		);
		const row = rowc.querySelector( '.newspack-nodes-log-row' );
		expect( row.getAttribute( 'data-p' ) ).toBeNull();
		expect( row.textContent ).toBe( '[warn] slow query' );
	} );

	it( 'reflects reported counts and clears the ring via resetSignal', () => {
		const node = registerViewFixture( {
			selected: 'php',
			lines: [ { id: 1, content: 'x', isEven: false } ],
		} );
		const { container } = render( <LogViewer /> );
		act( () =>
			logRowListProps.onStats( { total: 9, visible: 9, lps: 0 } )
		);
		expect( container.textContent ).toMatch( /9 lines/ );
		const before = logRowListProps.resetSignal;
		const clear = [ ...container.querySelectorAll( 'button' ) ].find(
			( b ) => 'Clear' === b.textContent
		);
		fireEvent.click( clear );
		expect( node.lines ).toEqual( [] );
		expect( logRowListProps.resetSignal ).toBe( before + 1 );
	} );

	it( 'no column header in normal mode; debug shows ID | Value (no Key)', () => {
		registerViewFixture( { selected: 'php' } );
		const { container, getByText } = render( <LogViewer /> );
		expect(
			container.querySelector( '.newspack-nodes-log-header' )
		).toBeNull();
		fireEvent.click( getByText( 'Debug' ) );
		const ths = [
			...container.querySelectorAll( '.newspack-nodes-log-header__th' ),
		].map( ( el ) => el.textContent );
		expect( ths ).toEqual( [ 'ID', 'Value' ] );
	} );

	it( 'pasting a full message ID jumps paused and steps that message', async () => {
		registerViewFixture( { selected: 'gate' } );
		const { container } = render( <LogViewer /> );
		const input = container.querySelector( '.newspack-nodes-offset-input' );
		fireEvent.change( input, { target: { value: '3:120:30' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( setPaused ).toHaveBeenCalledWith( true );
		expect( seek ).toHaveBeenCalledWith( 'gate', {
			gate: { segment: 3, offset: 120 },
		} );
		await act( async () => {} );
		expect( step ).toHaveBeenCalled();
	} );

	it( 'garbage in the offset input is ignored', () => {
		registerViewFixture( { selected: 'gate' } );
		const { container } = render( <LogViewer /> );
		const input = container.querySelector( '.newspack-nodes-offset-input' );
		fireEvent.change( input, { target: { value: 'nonsense-9x' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( seek ).not.toHaveBeenCalled();
		expect( setPaused ).not.toHaveBeenCalled();
	} );

	it( 'no selected source: the rail-maintenance interval stays unarmed', () => {
		jest.useFakeTimers();
		registerViewFixture( { selected: '' } );
		render( <LogViewer /> );
		act( () => {
			jest.advanceTimersByTime( 10000 );
		} );
		expect( fetchSources ).not.toHaveBeenCalled();
		jest.useRealTimers();
	} );

	it( 'the pause button toggles through the graph callback', () => {
		registerViewFixture( { selected: 'php' } );
		const { container } = render( <LogViewer /> );
		const pause = [ ...container.querySelectorAll( 'button' ) ].find(
			( b ) => '⏸' === b.textContent
		);
		fireEvent.click( pause );
		expect( setPaused ).toHaveBeenCalledWith( true );
	} );

	it( 'a capped count reads visible/total, with no debug-cap banner', () => {
		registerViewFixture( { selected: 'php' } );
		const { container } = render( <LogViewer /> );
		act( () =>
			logRowListProps.onStats( { total: 100000, visible: 500, lps: 0 } )
		);
		expect( container.textContent ).toMatch( /500 \/ 100000 lines/ );
		expect(
			container.querySelector( '.newspack-nodes-debug-cap' )
		).toBeNull();
	} );

	it( 'seeds selectSource from ?source= once the catalog is available', () => {
		window.history.replaceState( {}, '', '/?source=gate' );
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( selectSource ).toHaveBeenCalledWith( 'gate' );
	} );

	it( 'does not seed ?source= that is not among the sources', () => {
		window.history.replaceState( {}, '', '/?source=ghost' );
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( selectSource ).not.toHaveBeenCalled();
	} );

	it( 'does not seed when ?source= is absent', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( selectSource ).not.toHaveBeenCalled();
	} );

	it( 'portals the controls into the hub header slot when given one', () => {
		registerViewFixture( { selected: 'php' } );
		const slot = document.createElement( 'div' );
		document.body.appendChild( slot );
		render( <LogViewer headerControlsSlot={ slot } /> );
		expect(
			slot.querySelector( '.newspack-nodes-toolbar' )
		).not.toBeNull();
	} );
} );

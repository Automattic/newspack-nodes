/**
 * LogViewer UI-surface tests — the thin DOM view over the logviewer node graph.
 * The list (LogRowList) and source picker (LogBrowser) have their own suites; here
 * they are mocked to markers capturing the props LogViewer wires in, so these
 * tests cover the toolbar, source selection, Live/Replay, and `?source=` linking.
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

const SOURCES = [
	{ name: 'php', path: '/php', mode: 'file', available: true },
	{ name: 'debug', path: '/debug', mode: 'segmented', available: false },
];

// Stand-in logviewer:view node: model in setStateCache.view, ring on the node.
function registerViewFixture( {
	selected = '',
	paused = false,
	mode = 'live',
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
	} );
	Core.nodes.set( 'logviewer:view', node );
	return node;
}

describe( 'LogViewer', () => {
	let selectSource;
	let setPaused;
	let seek;

	function mockGraph( sources = SOURCES ) {
		useLogViewerGraph.mockReturnValue( {
			selectSource,
			setPaused,
			seek,
			sources,
		} );
	}

	beforeEach( () => {
		Core.reset();
		logRowListProps = undefined;
		logBrowserProps = undefined;
		selectSource = jest.fn();
		setPaused = jest.fn();
		seek = jest.fn();
		useLogViewerGraph.mockClear();
		mockGraph();
		window.history.replaceState( {}, '', '/' );
	} );

	it( 'renders a toolbar with filter + pause + clear (no log dropdown)', () => {
		registerViewFixture( { selected: 'php' } );
		const { container } = render( <LogViewer /> );
		expect(
			container.querySelector( '.newspack-nodes-search-input' )
		).not.toBeNull();
		expect(
			container.querySelector( '.newspack-nodes-select' )
		).toBeNull();
	} );

	it( 'lists the sources in the picker', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( logBrowserProps.items ).toBe( SOURCES );
		expect( logBrowserProps.selectedKey ).toBe( 'php' );
		expect( logBrowserProps.title ).toBe( 'Sources' );
	} );

	it( 'shapes each source row: name key/label, mode meta, availability gate', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( logBrowserProps.itemKey( SOURCES[ 1 ] ) ).toBe( 'debug' );
		expect( logBrowserProps.itemLabel( SOURCES[ 1 ] ) ).toBe( 'debug' );
		expect( logBrowserProps.itemMeta( SOURCES[ 1 ] ) ).toBe( 'segmented' );
		expect( logBrowserProps.itemDisabled( SOURCES[ 1 ] ) ).toBe( true );
		expect( logBrowserProps.itemDisabled( SOURCES[ 0 ] ) ).toBe( false );
	} );

	it( 'selecting a source switches the stream and reflects ?source=', () => {
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		act( () => logBrowserProps.onSelectItem( SOURCES[ 1 ] ) );
		expect( selectSource ).toHaveBeenCalledWith( 'debug' );
		expect( window.location.search ).toContain( 'source=debug' );
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
		const clear = container.querySelectorAll( '.button' );
		fireEvent.click( clear[ clear.length - 1 ] );
		expect( node.lines ).toEqual( [] );
		expect( logRowListProps.resetSignal ).toBe( before + 1 );
	} );

	it( 'seeds selectSource from ?source= once the catalog is available', () => {
		window.history.replaceState( {}, '', '/?source=debug' );
		registerViewFixture( { selected: 'php' } );
		render( <LogViewer /> );
		expect( selectSource ).toHaveBeenCalledWith( 'debug' );
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

/**
 * PartitionViewer UI-surface tests — the thin DOM view over the partition node
 * graph. The virtualized list (LogRowList) and browse sidebar (LogBrowser) are
 * exercised by their own suites; here they are mocked to markers that capture the
 * props PartitionViewer wires into them, so these tests cover the toolbar,
 * deep-linking, callbacks, and the browse/seek wiring.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { TM_STRUCT, TM_RESPONSE } from '../../runtime/message';
import { mountExospine } from '../../runtime/exospine';
import PartitionViewer from '../PartitionViewer';

// Capture the props PartitionViewer hands the shared list + sidebar each render.
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

// Own suite exercises this hook; mock it — 1 call/render = a render probe.
jest.mock( '../hooks/usePartitionViewerGraph', () => ( {
	usePartitionViewerGraph: jest.fn(),
} ) );

const {
	usePartitionViewerGraph,
} = require( '../hooks/usePartitionViewerGraph' );

// Stand-in partition:view node: model in setStateCache.view, ring on the node.
function registerViewFixture( {
	logs = [],
	selected = '',
	paused = false,
	connectionError = false,
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
		logs,
		selected,
		paused,
		connectionError,
		mode,
		lastReceivedSegment,
	} );
	Core.nodes.set( 'partition:view', node );
	return node;
}

describe( 'PartitionViewer', () => {
	let selectLog;
	let setPaused;
	let fetchLogStatus;
	let seek;
	let step;
	let clearGraph;

	// Wrap render in act so the async log_status fetch effect settles inside it.
	async function renderViewer( props = {} ) {
		let out;
		await act( async () => {
			out = render( <PartitionViewer { ...props } /> );
		} );
		return out;
	}

	beforeEach( () => {
		Core.reset();
		logRowListProps = undefined;
		logBrowserProps = undefined;
		selectLog = jest.fn();
		setPaused = jest.fn();
		fetchLogStatus = jest.fn().mockResolvedValue( { segments: [] } );
		seek = jest.fn();
		step = jest.fn();
		clearGraph = jest.fn();
		usePartitionViewerGraph.mockClear();
		usePartitionViewerGraph.mockReturnValue( {
			selectLog,
			setPaused,
			fetchLogStatus,
			seek,
			step,
			clear: clearGraph,
			setFilter: ( term ) => {
				const view = Core.nodes.get( 'partition:view' );
				if ( view ) {
					view.filter = String( term ).toLowerCase();
				}
			},
		} );
		window.history.replaceState( {}, '', '/' );
		window.localStorage.clear();
	} );

	it( 'renders a select populated from the view model', async () => {
		registerViewFixture( {
			logs: [
				{ key: 'firehose', label: 'Firehose' },
				{ key: 'errors', label: 'Errors' },
			],
			selected: 'firehose',
		} );
		const { container } = await renderViewer();
		const select = container.querySelector( '.newspack-nodes-select' );
		expect( select ).not.toBeNull();
		expect( select.options.length ).toBe( 2 );
		expect( select.value ).toBe( 'firehose' );
	} );

	it( 'shows "No logs available" when the view model has no logs', async () => {
		registerViewFixture( { logs: [] } );
		const { container } = await renderViewer();
		expect( container.textContent ).toMatch( /No logs available/ );
	} );

	it( 'selecting a log calls selectLog and reflects it into ?log=', async () => {
		registerViewFixture( {
			logs: [
				{ key: 'firehose', label: 'Firehose' },
				{ key: 'errors', label: 'Errors' },
			],
			selected: 'firehose',
		} );
		const { container } = await renderViewer();
		const select = container.querySelector( '.newspack-nodes-select' );
		fireEvent.change( select, { target: { value: 'errors' } } );
		expect( selectLog ).toHaveBeenCalledWith( 'errors' );
		expect( window.location.search ).toContain( 'log=errors' );
	} );

	it( 'marks only the paused control and toggles both stream states', async () => {
		const node = registerViewFixture( { logs: [], paused: false } );
		const { container } = await renderViewer();

		const running = container.querySelector(
			'button[title="Pause streaming"]'
		);
		expect( running ).not.toBeNull();
		expect( running.classList.contains( 'is-paused' ) ).toBe( false );
		expect( container.querySelectorAll( 'button.is-paused' ) ).toHaveLength(
			0
		);
		fireEvent.click( running );
		expect( setPaused ).toHaveBeenCalledWith( true );

		act( () => {
			node.setState( 'view', {
				...node.setStateCache.view,
				paused: true,
			} );
		} );

		const pausedButtons = container.querySelectorAll( 'button.is-paused' );
		expect( pausedButtons ).toHaveLength( 1 );
		const [ paused ] = pausedButtons;
		expect( paused ).not.toBeNull();
		expect( paused.getAttribute( 'title' ) ).toBe( 'Resume streaming' );
		fireEvent.click( paused );
		expect( setPaused ).toHaveBeenLastCalledWith( false );
	} );

	it( 'wires LogRowList getNode at the live partition:view node', async () => {
		const node = registerViewFixture( { logs: [] } );
		await renderViewer();
		expect( logRowListProps.getNode() ).toBe( node );
		expect( logRowListProps.rowHeight ).toBe( 33 );
		expect( logRowListProps.listClassName ).toBe(
			'newspack-nodes-partition-rows'
		);
	} );

	it( 'sends the toolbar filter to the view node as an ingest control', async () => {
		// The ring must hold only what is displayed: filtering at render left
		// non-matches consuming slots, so a rare match aged out of the buffer.
		const node = registerViewFixture( { logs: [] } );
		const { container } = await renderViewer();
		const input = container.querySelector( '.newspack-nodes-search-input' );

		fireEvent.change( input, { target: { value: 'zebra' } } );

		expect( node.filter ).toBe( 'zebra' );
		expect( logRowListProps.filter ).toBeUndefined();
	} );

	it( 'reflects the count LogRowList reports up into the toolbar', async () => {
		registerViewFixture( { logs: [] } );
		const { container } = await renderViewer();
		act( () =>
			logRowListProps.onStats( { total: 40, visible: 40, lps: 3.5 } )
		);
		expect( container.textContent ).toMatch( /40 lines/ );
		expect( container.textContent ).toMatch( /3\.5 lines\/s/ );
	} );

	it( 'clear empties the ring and rebases the list via resetSignal', async () => {
		const node = registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lines: [ { id: 1, partition: 0, content: 'a', isEven: false } ],
		} );
		const { container } = await renderViewer();
		const before = logRowListProps.resetSignal;
		const clear = [ ...container.querySelectorAll( 'button' ) ].find(
			( b ) => 'Clear' === b.textContent
		);
		fireEvent.click( clear );
		// Clear travels as the view's control; the viewer never blanks `lines`.
		expect( clearGraph ).toHaveBeenCalledTimes( 1 );
		expect( node.lines ).toEqual( [
			{ id: 1, partition: 0, content: 'a', isEven: false },
		] );
		expect( logRowListProps.resetSignal ).toBe( before + 1 );
	} );

	// The viewer streams ONE partition at a time (`resubscribe([ log ])`), so a
	// P<n> gutter on every row named the only thing on screen.
	it( 'renderRow draws no partition gutter', async () => {
		registerViewFixture( { logs: [] } );
		await renderViewer();
		const { container } = render(
			logRowListProps.renderRow( {
				id: 7,
				partition: 3,
				content: 'GET /x 200',
				value: 'GET /x 200',
				isEven: true,
			} )
		);
		const row = container.querySelector( '.newspack-nodes-log-row' );
		expect( row.classList.contains( 'row-even' ) ).toBe( true );
		expect( row.getAttribute( 'data-p' ) ).toBeNull();
		expect( row.textContent ).toContain( 'GET /x 200' );
	} );

	it( 'portals the controls into the hub header slot when given one', async () => {
		registerViewFixture( { logs: [] } );
		const slot = document.createElement( 'div' );
		document.body.appendChild( slot );
		await renderViewer( { headerControlsSlot: slot } );
		expect(
			slot.querySelector( '.newspack-nodes-toolbar' )
		).not.toBeNull();
	} );

	it( 'fetches the selected log segments and lists them in the browser', async () => {
		fetchLogStatus.mockResolvedValue( {
			segments: [
				{ id: 4, size: 100 },
				{ id: 5, size: 2048 },
			],
		} );
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		expect( fetchLogStatus ).toHaveBeenCalledWith( 'firehose' );
		expect( logBrowserProps.items ).toEqual( [
			{ id: 4, size: 100 },
			{ id: 5, size: 2048 },
		] );
	} );

	it( 'browsing a segment enters pause mode (time-travel)', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		act( () => logBrowserProps.onSelectItem( { id: 7, size: 1 } ) );
		expect( setPaused ).toHaveBeenCalledWith( true );
	} );

	it( 'step button steps once while paused; disabled while live', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			paused: true,
		} );
		const { getByTitle } = await renderViewer();
		const button = getByTitle( 'Step one message (paused only)' );
		expect( button.disabled ).toBe( false );
		fireEvent.click( button );
		expect( step ).toHaveBeenCalled();
	} );

	it( 'step button is disabled while live', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { getByTitle } = await renderViewer();
		expect( getByTitle( 'Step one message (paused only)' ).disabled ).toBe(
			true
		);
	} );

	it( 'the segment rail refreshes on an interval', async () => {
		jest.useFakeTimers();
		// The rail rides the Router TIMER; the graph hook is mocked out here,
		// so stand in the backbone the real usePartitionViewerGraph brings up.
		const host = mountExospine( () => {} );
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		expect( fetchLogStatus ).toHaveBeenCalledTimes( 1 );
		await act( async () => {
			jest.advanceTimersByTime( 10000 );
		} );
		expect( fetchLogStatus ).toHaveBeenCalledTimes( 2 );
		host.teardown();
		jest.useRealTimers();
	} );

	it( 'a record from an unknown segment refetches the rail once', async () => {
		fetchLogStatus.mockResolvedValue( {
			segments: [ { id: 0, size: 10 } ],
		} );
		const node = registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		expect( fetchLogStatus ).toHaveBeenCalledTimes( 1 );
		// A rotation: the stream reports a segment the rail doesn't know.
		await act( async () => {
			node.setState( 'view', {
				...node.setStateCache.view,
				lastReceivedSegment: 1,
			} );
		} );
		expect( fetchLogStatus ).toHaveBeenCalledTimes( 2 );
		// The SAME unknown segment must not refetch again (no loop).
		await act( async () => {
			node.setState( 'view', { ...node.setStateCache.view } );
		} );
		expect( fetchLogStatus ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'normal mode shows the default ID | Key | Value columns and split row cells', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { container } = await renderViewer();
		const ths = [
			...container.querySelectorAll( '.newspack-nodes-log-header__th' ),
		].map( ( el ) => el.textContent );
		expect( ths ).toEqual( [ 'ID', 'Key', 'Value' ] );

		const { container: rowc } = render(
			logRowListProps.renderRow( {
				id: 9,
				partition: 1,
				key: 'jobstats',
				value: '{"n":4}',
				content: 'jobstats: {"n":4}',
				isEven: false,
			} )
		);
		expect(
			rowc.querySelector( '.newspack-nodes-log-row__key' ).textContent
		).toBe( 'jobstats' );
		expect(
			rowc.querySelector( '.newspack-nodes-log-row__value' ).textContent
		).toBe( '{"n":4}' );
	} );

	// A partition record IS a Message, so its columns are the seven positional
	// fields. The viewer showed three of them and offered no way to the rest.
	it( 'the Cols picker offers every message field, and enabling one renders it', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { container, getByText } = await renderViewer();

		fireEvent.click( getByText( 'Cols' ) );
		const labels = [
			...container.querySelectorAll(
				'.newspack-nodes-column-picker label'
			),
		].map( ( el ) => el.textContent.trim() );
		expect( labels ).toEqual( [
			'Type',
			'Time',
			'From',
			'To',
			'ID',
			'Key',
			'Value',
		] );

		fireEvent.click( container.querySelector( '#pv-col-type' ) );
		fireEvent.click( container.querySelector( '#pv-col-timestamp' ) );

		const { container: rowc } = render(
			logRowListProps.renderRow( {
				id: 9,
				type: TM_STRUCT | TM_RESPONSE,
				timestamp: 1786499281.301584,
				key: 'jobstats',
				value: '{"n":4}',
				isEven: false,
			} )
		);
		// TYPE is a bitmask and TIMESTAMP epoch seconds; neither reads as itself.
		// Flags render in the canonical TYPE_NAMES order, not the order written.
		expect(
			rowc.querySelector( '.newspack-nodes-log-row__type' ).textContent
		).toBe( 'TM_RESPONSE | TM_STRUCT' );
		expect(
			rowc.querySelector( '.newspack-nodes-log-row__ts' ).textContent
		).toMatch( /^\d{4}-\d{2}-\d{2} / );
	} );

	// VALUE is the payload; every other column is metadata about it, and reads
	// dimmer so the eye lands on the record. The shared debug row already did
	// this for ID — the column-driven cells have to keep it.
	it( 'dims every non-VALUE column and leaves VALUE at full contrast', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { container, getByText } = await renderViewer();
		fireEvent.click( getByText( 'Cols' ) );
		for ( const col of [ 'type', 'timestamp', 'from', 'to' ] ) {
			fireEvent.click( container.querySelector( `#pv-col-${ col }` ) );
		}

		const { container: rowc } = render(
			logRowListProps.renderRow( {
				id: 11,
				type: TM_STRUCT,
				timestamp: 1786499281,
				from: 'jobs.p0',
				to: 'sink',
				msgId: '1:2:3',
				key: 'k',
				value: 'v',
				isEven: true,
			} )
		);
		const dim = [ 'type', 'ts', 'from', 'to', 'id', 'key' ];
		for ( const cls of dim ) {
			expect(
				rowc
					.querySelector( `.newspack-nodes-log-row__${ cls }` )
					.classList.contains( 'is-muted' )
			).toBe( true );
		}
		expect(
			rowc
				.querySelector( '.newspack-nodes-log-row__value' )
				.classList.contains( 'is-muted' )
		).toBe( false );
	} );

	it( 'debug mode shows an ID | Key | Value column header', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { getByText, container } = await renderViewer();
		fireEvent.click( getByText( 'Debug' ) );
		const ths = [
			...container.querySelectorAll( '.newspack-nodes-log-header__th' ),
		].map( ( el ) => el.textContent );
		expect( ths ).toEqual( [ 'ID', 'Key', 'Value' ] );
	} );

	it( 'debug toggle switches the list into the ID-KEY-VALUE debug renderer', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { getByText, container } = await renderViewer();
		expect( logRowListProps.debug ).toBe( false );
		fireEvent.click( getByText( 'Debug' ) );
		expect( logRowListProps.debug ).toBe( true );

		const { container: rowc } = render(
			logRowListProps.renderRow( {
				id: 1,
				msgId: '7:120:30',
				key: 'rid-4194',
				struct: true,
				raw: '{"deep":977}',
				partition: 2,
				isEven: false,
			} )
		);
		const row = rowc.querySelector( '.newspack-nodes-log-row.is-debug' );
		expect( row.textContent ).toContain( '7:120:30' );
		expect( row.textContent ).toContain( 'rid-4194' );
		// TM_STRUCT payloads pretty-print.
		expect( row.textContent ).toContain( '"deep": 977' );
		expect( container ).toBeTruthy();
	} );

	it( 'pasting a full message ID jumps paused and steps that one message', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		const { container } = await renderViewer();
		const input = container.querySelector( '.newspack-nodes-offset-input' );
		fireEvent.change( input, { target: { value: '7:120:30' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( setPaused ).toHaveBeenCalledWith( true );
		expect( seek ).toHaveBeenCalledWith(
			'firehose',
			{ firehose: { segment: 7, offset: 120 } },
			{ segments: [] }
		);
		await act( async () => {} );
		expect( step ).toHaveBeenCalled();
	} );

	it( 'pasting a bare offset jumps within the last-received segment', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			lastReceivedSegment: 9,
		} );
		const { container } = await renderViewer();
		const input = container.querySelector( '.newspack-nodes-offset-input' );
		fireEvent.change( input, { target: { value: '4400' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( seek ).toHaveBeenCalledWith(
			'firehose',
			{ firehose: { segment: 9, offset: 4400 } },
			{ segments: [] }
		);
	} );

	it( 'browsing a segment seeks the stream to it at offset 0', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		act( () => logBrowserProps.onSelectItem( { id: 7, size: 1 } ) );
		// Third arg is the source ROW; the hook derives the boundary from it.
		expect( seek ).toHaveBeenCalledWith(
			'firehose',
			{ firehose: { segment: 7, offset: 0 } },
			{ segments: [] }
		);
		expect( logBrowserProps.selectedKey ).toBe( 7 );
	} );

	it( 'replay seeks the stream to start', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		act( () => logBrowserProps.onReplay() );
		expect( seek ).toHaveBeenCalledWith(
			'firehose',
			{ firehose: 'start' },
			{ segments: [] }
		);
	} );

	it( 'displays the view-derived mode + last-received segment (not the clicked one)', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
			mode: 'replay',
			lastReceivedSegment: 8,
		} );
		await renderViewer();
		expect( logBrowserProps.mode ).toBe( 'replay' );
		expect( logBrowserProps.activeKey ).toBe( 8 );
	} );

	it( 'captures the newest segment as the replay end so the view can catch up', async () => {
		fetchLogStatus.mockResolvedValue( {
			segments: [
				{ id: 4, size: 100 },
				{ id: 6, size: 2048 },
			],
		} );
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		act( () => logBrowserProps.onReplay() );
		// The ROW rides; browseControl() derives segment 6 @ 2048 from it.
		expect( seek ).toHaveBeenCalledWith(
			'firehose',
			{ firehose: 'start' },
			{
				segments: [
					{ id: 4, size: 100 },
					{ id: 6, size: 2048 },
				],
			}
		);
	} );

	it( 'Live returns the stream to the tail (null positions)', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		act( () => logBrowserProps.onSelectItem( { id: 7, size: 1 } ) );
		act( () => logBrowserProps.onFollow() );
		expect( seek ).toHaveBeenLastCalledWith( 'firehose', null );
		expect( logBrowserProps.mode ).toBe( 'live' );
	} );

	it( 'shapes each segment row: key, label, and a compact byte meta', async () => {
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		expect( logBrowserProps.itemKey( { id: 9, size: 1 } ) ).toBe( 9 );
		expect( logBrowserProps.itemLabel( { id: 9 } ) ).toBe( 'Segment 9' );
		expect( logBrowserProps.itemMeta( { size: 0 } ) ).toBe( '0 B' );
		expect( logBrowserProps.itemMeta( { size: 512 } ) ).toBe( '512 B' );
		expect( logBrowserProps.itemMeta( { size: 2048 } ) ).toBe( '2 KB' );
		expect( logBrowserProps.itemMeta( { size: 3 * 1024 * 1024 } ) ).toBe(
			'3 MB'
		);
	} );

	it( 'falls back to no segments when the log_status fetch fails', async () => {
		fetchLogStatus.mockRejectedValue( new Error( 'boom' ) );
		registerViewFixture( {
			logs: [ { key: 'firehose', label: 'Firehose' } ],
			selected: 'firehose',
		} );
		await renderViewer();
		expect( logBrowserProps.items ).toEqual( [] );
	} );

	describe( '?log= deep-linking', () => {
		it( 'seeds selectLog from ?log= once the log is available', async () => {
			window.history.replaceState( {}, '', '/?log=errors' );
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			await renderViewer();
			expect( selectLog ).toHaveBeenCalledWith( 'errors' );
		} );

		it( 'does not seed a ?log= that arrives only in a later catalog', async () => {
			window.history.replaceState( {}, '', '/?log=errors' );
			// First non-empty catalog lacks 'errors' — the seed chance is spent.
			const node = registerViewFixture( {
				logs: [ { key: 'firehose', label: 'Firehose' } ],
				selected: 'firehose',
			} );
			await renderViewer();
			expect( selectLog ).not.toHaveBeenCalledWith( 'errors' );

			// 'errors' arrives later — it must NOT override the selection.
			await act( async () =>
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

		it( 'seeds at most once even across re-renders', async () => {
			window.history.replaceState( {}, '', '/?log=errors' );
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			const { rerender } = await renderViewer();
			await act( async () => rerender( <PartitionViewer /> ) );
			expect(
				selectLog.mock.calls.filter( ( c ) => c[ 0 ] === 'errors' )
					.length
			).toBe( 1 );
		} );

		it( 'does not seed when ?log= matches the already-selected log', async () => {
			window.history.replaceState( {}, '', '/?log=firehose' );
			registerViewFixture( {
				logs: [ { key: 'firehose', label: 'Firehose' } ],
				selected: 'firehose',
			} );
			await renderViewer();
			expect( selectLog ).not.toHaveBeenCalled();
		} );

		it( 'does not seed when ?log= is not among the available logs', async () => {
			window.history.replaceState( {}, '', '/?log=ghost' );
			registerViewFixture( {
				logs: [ { key: 'firehose', label: 'Firehose' } ],
				selected: 'firehose',
			} );
			await renderViewer();
			expect( selectLog ).not.toHaveBeenCalled();
		} );

		it( 'does not seed when ?log= is absent', async () => {
			registerViewFixture( {
				logs: [
					{ key: 'firehose', label: 'Firehose' },
					{ key: 'errors', label: 'Errors' },
				],
				selected: 'firehose',
			} );
			await renderViewer();
			expect( selectLog ).not.toHaveBeenCalled();
		} );
	} );
} );

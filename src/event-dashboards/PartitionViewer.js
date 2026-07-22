/**
 * Partition Viewer Component — DOM-rendered real-time stream of log lines.
 *
 * A THIN view over the `partition:*` node graph (mounted by
 * `usePartitionViewerGraph`): `partition:link` holds the SSE connection and
 * `partition:view` holds the ring + view model. The virtualized row list is the
 * shared `LogRowList`, which pulls only the on-screen window off the ring each
 * frame (no 100k materialization) — this component owns the toolbar (log picker,
 * filter, counts, pause, clear) and the deep-link/staleness chrome.
 *
 * Two read paths: LOW frequency `useNodeState('partition:view','view')` for the
 * `{ logs, selected, paused, connectionError }` model, and the counts LogRowList
 * reports up via `onStats`. The former canvas + rAF loop is gone — the DOM rows
 * theme light/dark for free.
 */

import {
	useState,
	useEffect,
	useRef,
	useCallback,
	createPortal,
} from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { usePartitionViewerGraph } from './hooks/usePartitionViewerGraph';
import LogRowList from '@newspack-nodes/shared/components/LogRowList';
import LogBrowser from '@newspack-nodes/shared/components/LogBrowser';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import { endPosition } from '../shared/nodes/seekTracker';
import useLogPositions, {
	segmentPositions,
	replayPositions,
} from '@newspack-nodes/shared/hooks/useLogPositions';
import {
	getQueryParam,
	setQueryParam,
} from '@newspack-nodes/shared/utils/queryParams';
import './styles/partition-viewer.scss';

const ROW_HEIGHT = 18;
const VIEW_NODE = 'partition:view';
// SSE connector owns liveness; "Xs ago" reads its lastEventTime, not the view.
const LINK_NODE = 'partition:link';

const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
	mode: 'live',
	lastReceivedSegment: null,
};

// Compact byte size for the segment sidebar meta column.
const formatBytes = ( bytes ) => {
	if ( ! bytes ) {
		return '0 B';
	}
	if ( bytes < 1024 ) {
		return `${ bytes } B`;
	}
	if ( bytes < 1024 * 1024 ) {
		return `${ ( bytes / 1024 ).toFixed( 1 ) } KB`;
	}
	return `${ ( bytes / ( 1024 * 1024 ) ).toFixed( 1 ) } MB`;
};

// One envelope row; row height + the P<n> gutter come from the partition CSS.
const renderPartitionRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-log-row ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
		data-p={ row.partition }
	>
		{ row.content }
	</div>
);

/**
 * Partition Viewer Component.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function PartitionViewer( { headerControlsSlot } ) {
	// Mount the node graph; it returns the thin control callbacks.
	const { selectLog, setPaused, fetchLogStatus, seek } =
		usePartitionViewerGraph();

	// Low-frequency view model (dropdown + pause button + selected value).
	const view = useNodeState( VIEW_NODE, 'view' ) ?? EMPTY_VIEW;
	const {
		logs: availableLogs,
		selected: selectedLog,
		paused: isPaused,
		connectionError,
		// Actual streaming state (from the view's breadcrumbs), not the click.
		mode: displayMode,
		lastReceivedSegment,
	} = view;

	// One-shot `?log=` seed: selects that log on FIRST catalog, then disarms.
	const urlLogRef = useRef( getQueryParam( 'log' ) );
	const seededLogRef = useRef( false );
	useEffect( () => {
		if ( seededLogRef.current || 0 === availableLogs.length ) {
			return;
		}
		seededLogRef.current = true;
		const urlLog = urlLogRef.current;
		if (
			urlLog &&
			availableLogs.some( ( l ) => l.key === urlLog ) &&
			urlLog !== selectedLog
		) {
			selectLog( urlLog );
		}
	}, [ availableLogs, selectedLog, selectLog ] );

	// User log pick: drive the graph AND reflect into `?log=` for deep-linking.
	const handleSelectLog = ( log ) => {
		selectLog( log );
		setQueryParam( 'log', log );
	};

	const [ filter, setFilter ] = useState( '' );
	// Counts LogRowList reports up (row DATA never becomes React state).
	const [ stats, setStats ] = useState( { total: 0, visible: 0, lps: 0 } );
	const handleStats = useCallback( ( next ) => setStats( next ), [] );
	// Bumped to rebase the list on Clear (also re-reads the emptied ring).
	const [ resetSignal, setResetSignal ] = useState( 0 );

	// Re-read the live view node each frame so a graph reinit is picked up.
	const getViewNode = useCallback( () => Core.node( VIEW_NODE ), [] );

	// Seek intent drives positions; displayed mode comes from the view.
	const { segmentId, follow, browseSegment, replay } =
		useLogPositions( selectedLog );
	const [ segments, setSegments ] = useState( [] );
	useEffect( () => {
		if ( ! selectedLog ) {
			setSegments( [] );
			return undefined;
		}
		let cancelled = false;
		fetchLogStatus( selectedLog )
			.then( ( status ) => {
				if ( ! cancelled ) {
					setSegments( status?.segments ?? [] );
				}
			} )
			.catch( () => {
				if ( ! cancelled ) {
					setSegments( [] );
				}
			} );
		return () => {
			cancelled = true;
		};
	}, [ selectedLog, fetchLogStatus ] );

	// Browse: update seek intent, reposition, and carry the end for catch-up.
	const handleFollow = () => {
		follow();
		seek( selectedLog, null );
	};
	const handleReplay = () => {
		replay();
		seek(
			selectedLog,
			replayPositions( selectedLog ),
			endPosition( segments )
		);
	};
	const handleBrowseSegment = ( segment ) => {
		browseSegment( segment.id );
		seek(
			selectedLog,
			segmentPositions( selectedLog, segment.id ),
			endPosition( segments )
		);
	};

	// Ticking "Xs ago" display, read off the link's last-frame clock.
	const [ now, setNow ] = useState( Date.now() );
	useEffect( () => {
		const id = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( id );
	}, [] );
	const lastEventTime = Core.node( LINK_NODE )?.lastEventTime() ?? null;
	const staleSec = lastEventTime
		? Math.max( 0, Math.floor( ( now - lastEventTime ) / 1000 ) )
		: null;

	// Clear all lines — empties the node ring; the next frame reflects 0 lines.
	const handleClear = () => {
		const node = Core.node( VIEW_NODE );
		if ( node ) {
			node.lines = [];
		}
		setStats( { total: 0, visible: 0, lps: 0 } );
		setResetSignal( ( n ) => n + 1 );
	};

	const emptyLabel = isPaused
		? __( 'Paused', 'newspack-nodes' )
		: __( 'Waiting for log lines…', 'newspack-nodes' );

	// Controls strip portals into the hub header slot; undefined = inline.
	const controls = (
		<div className="newspack-nodes-toolbar">
			{ availableLogs.length === 0 && (
				<span className="newspack-nodes-partition-viewer-status">
					{ __( 'No logs available', 'newspack-nodes' ) }
				</span>
			) }
			{ availableLogs.length > 0 && (
				<select
					className="newspack-nodes-select"
					value={ selectedLog }
					onChange={ ( e ) => handleSelectLog( e.target.value ) }
				>
					{ availableLogs.map( ( log ) => (
						<option key={ log.key } value={ log.key }>
							{ log.label }
						</option>
					) ) }
				</select>
			) }

			<input
				type="text"
				className="newspack-nodes-search-input"
				placeholder={ __( 'Filter…', 'newspack-nodes' ) }
				value={ filter }
				onChange={ ( e ) => setFilter( e.target.value ) }
			/>

			<span className="newspack-nodes-toolbar-stats">
				<span className="newspack-nodes-toolbar-stats__count">
					{ filter
						? sprintf(
								// translators: 1: number of matching lines, 2: total number of lines.
								_n(
									'%1$d / %2$d line',
									'%1$d / %2$d lines',
									stats.total,
									'newspack-nodes'
								),
								stats.visible,
								stats.total
						  )
						: sprintf(
								// translators: %d: number of lines.
								_n(
									'%d line',
									'%d lines',
									stats.visible,
									'newspack-nodes'
								),
								stats.visible
						  ) }
				</span>
				{ stats.lps > 0 && (
					<span className="newspack-nodes-toolbar-stats__rps">
						{ sprintf(
							// translators: %s: lines-per-second rate (one decimal place).
							__( '%s lines/s', 'newspack-nodes' ),
							stats.lps.toFixed( 1 )
						) }
					</span>
				) }
				{ staleSec !== null && (
					<span
						style={ {
							color: staleSec > 10 ? '#dba617' : '#757575',
							fontSize: '11px',
							marginLeft: '8px',
						} }
					>
						{ sprintf(
							// translators: %d: number of seconds since the last log line.
							__( '%ds ago', 'newspack-nodes' ),
							staleSec
						) }
					</span>
				) }
			</span>

			<button
				className={ `button ${ isPaused ? 'is-paused' : '' }` }
				onClick={ () => setPaused( ! isPaused ) }
				title={
					isPaused
						? __( 'Resume streaming', 'newspack-nodes' )
						: __( 'Pause streaming', 'newspack-nodes' )
				}
			>
				{ isPaused ? '▶' : '⏸' }
			</button>

			<button
				className="button"
				onClick={ handleClear }
				title={ __( 'Clear all lines', 'newspack-nodes' ) }
			>
				{ __( 'Clear', 'newspack-nodes' ) }
			</button>
		</div>
	);
	let renderedControls = null;
	if ( headerControlsSlot ) {
		renderedControls = createPortal( controls, headerControlsSlot );
	} else if ( undefined === headerControlsSlot ) {
		renderedControls = controls;
	}

	return (
		<div
			className="newspack-nodes-partition-viewer"
			role="region"
			aria-label={ __( 'Partition Viewer', 'newspack-nodes' ) }
		>
			{ renderedControls }

			<ConnectionBanner
				connectionError={ connectionError }
				message={ __(
					'Connection lost. Reconnecting…',
					'newspack-nodes'
				) }
			/>

			<div className="newspack-nodes-partition-viewer__body">
				<LogBrowser
					mode={ displayMode }
					onFollow={ handleFollow }
					onReplay={ handleReplay }
					items={ segments }
					selectedKey={ segmentId }
					activeKey={ lastReceivedSegment }
					onSelectItem={ handleBrowseSegment }
					itemKey={ ( s ) => s.id }
					itemLabel={ ( s ) =>
						sprintf(
							// translators: %d: log segment number.
							__( 'Segment %d', 'newspack-nodes' ),
							s.id
						)
					}
					itemMeta={ ( s ) => formatBytes( s.size ) }
					title={ __( 'Segments', 'newspack-nodes' ) }
					emptyLabel={ __( 'No segments', 'newspack-nodes' ) }
				/>

				<LogRowList
					getNode={ getViewNode }
					rowHeight={ ROW_HEIGHT }
					renderRow={ renderPartitionRow }
					filter={ filter }
					emptyLabel={ emptyLabel }
					onStats={ handleStats }
					resetSignal={ resetSignal }
					listClassName="newspack-nodes-partition-rows"
				/>
			</div>
		</div>
	);
}

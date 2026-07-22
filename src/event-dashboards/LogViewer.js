/**
 * Log Viewer Component — DOM-rendered live tail of plain log FILES.
 *
 * A THIN view over the `logviewer:*` graph (mounted by `useLogViewerGraph`),
 * which opens the substrate's `GET /log/stream` and catalogs sources via `taillog
 * sources`. The rows are RAW log-file lines (no partition column) rendered by the
 * shared `LogRowList`; the shared `LogBrowser` is the SOURCE picker (there are no
 * segments in file mode) with Live / Replay position controls. This component
 * owns the toolbar (filter, counts, pause, clear) + the staleness/deep-link chrome.
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
import { useLogViewerGraph } from './hooks/useLogViewerGraph';
import LogRowList from '@newspack-nodes/shared/components/LogRowList';
import LogBrowser from '@newspack-nodes/shared/components/LogBrowser';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import useLogPositions, {
	replayPositions,
} from '@newspack-nodes/shared/hooks/useLogPositions';
import {
	getQueryParam,
	setQueryParam,
} from '@newspack-nodes/shared/utils/queryParams';
import './styles/log-viewer.scss';

const ROW_HEIGHT = 18;
const VIEW_NODE = 'logviewer:view';
// SSE connector owns liveness; "Xs ago" reads its lastEventTime, not the view.
const LINK_NODE = 'logviewer:link';

const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
	mode: 'live',
};

// One raw log line row (no partition gutter; height from the shared class).
const renderRawRow = ( row ) => (
	<div
		key={ row.id }
		className={ `newspack-nodes-log-row ${
			row.isEven ? 'row-even' : 'row-odd'
		}` }
	>
		{ row.content }
	</div>
);

/**
 * Log Viewer Component.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function LogViewer( { headerControlsSlot } ) {
	const { selectSource, setPaused, seek, sources } = useLogViewerGraph();

	const view = useNodeState( VIEW_NODE, 'view' ) ?? EMPTY_VIEW;
	const {
		selected: currentSource,
		paused: isPaused,
		connectionError,
		// Displayed Live/Replay comes from the view's actual streaming state.
		mode: displayMode,
	} = view;

	// One-shot `?source=` seed: selects it on FIRST catalog, then disarms.
	const urlSourceRef = useRef( getQueryParam( 'source' ) );
	const seededRef = useRef( false );
	useEffect( () => {
		if ( seededRef.current || 0 === sources.length ) {
			return;
		}
		seededRef.current = true;
		const urlSource = urlSourceRef.current;
		if (
			urlSource &&
			sources.some( ( s ) => s.name === urlSource ) &&
			urlSource !== currentSource
		) {
			selectSource( urlSource );
		}
	}, [ sources, currentSource, selectSource ] );

	// Pick a source: switch the stream AND reflect into `?source=`.
	const handleSelectSource = ( source ) => {
		selectSource( source.name );
		setQueryParam( 'source', source.name );
	};

	const [ filter, setFilter ] = useState( '' );
	const [ stats, setStats ] = useState( { total: 0, visible: 0, lps: 0 } );
	const handleStats = useCallback( ( next ) => setStats( next ), [] );
	const [ resetSignal, setResetSignal ] = useState( 0 );
	const getViewNode = useCallback( () => Core.node( VIEW_NODE ), [] );

	// Seek intent (Live tail / Replay); displayed mode comes from the view.
	const { follow, replay } = useLogPositions( currentSource );
	const handleFollow = () => {
		follow();
		seek( currentSource, null );
	};
	const handleReplay = () => {
		replay();
		seek( currentSource, replayPositions( currentSource ) );
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

	const controls = (
		<div className="newspack-nodes-toolbar">
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
			className="newspack-nodes-log-viewer"
			role="region"
			aria-label={ __( 'Log Viewer', 'newspack-nodes' ) }
		>
			{ renderedControls }

			<ConnectionBanner
				connectionError={ connectionError }
				message={ __(
					'Connection lost. Reconnecting…',
					'newspack-nodes'
				) }
			/>

			<div className="newspack-nodes-log-viewer__body">
				<LogBrowser
					mode={ displayMode }
					onFollow={ handleFollow }
					onReplay={ handleReplay }
					items={ sources }
					selectedKey={ currentSource }
					onSelectItem={ handleSelectSource }
					itemKey={ ( s ) => s.name }
					itemLabel={ ( s ) => s.name }
					itemMeta={ ( s ) => s.mode }
					itemDisabled={ ( s ) => ! s.available }
					title={ __( 'Sources', 'newspack-nodes' ) }
					emptyLabel={ __( 'No sources', 'newspack-nodes' ) }
				/>

				<LogRowList
					getNode={ getViewNode }
					rowHeight={ ROW_HEIGHT }
					renderRow={ renderRawRow }
					filter={ filter }
					emptyLabel={ emptyLabel }
					onStats={ handleStats }
					resetSignal={ resetSignal }
				/>
			</div>
		</div>
	);
}

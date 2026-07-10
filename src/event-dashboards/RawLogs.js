/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * Raw Logs Component — canvas-rendered real-time stream of log lines.
 *
 * This is a THIN view over the `rawlogs:*` node graph (mounted by
 * `useRawLogsGraph`). The graph owns all data: `rawlogs:stream` holds the SSE
 * connection, `rawlogs:transform` turns envelopes into rows, and `rawlogs:view`
 * holds the buffer + view model. This component only renders.
 *
 * Two read paths, matching the view node's two cadences:
 * - LOW frequency: `useNodeState('rawlogs:view','view')` for `{ logs, selected,
 *   paused }` (the dropdown, pause button, selected value).
 * - HIGH frequency: the canvas rAF reads `Core.node('rawlogs:view')` directly
 *   every frame — `.linesCount` + `.lineAt(i)` for the on-screen window only (so
 *   a full 100k buffer costs O(rows-on-screen), not O(buffer), per frame) plus
 *   `.lps` — so a busy stream never re-renders React per line.
 */

import { useState, useEffect, useRef, createPortal } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { useRawLogsGraph } from './hooks/useRawLogsGraph';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import {
	getQueryParam,
	setQueryParam,
} from '@newspack-nodes/shared/utils/queryParams';
import './styles/raw-logs.scss';

const ROW_HEIGHT = 18;
const PARTITION_WIDTH = 36;
const FONT = '12px monospace';
const VIEW_NODE = 'rawlogs:view';
// SSE connector owns liveness; "Xs ago" reads its lastEventTime, not the view.
const LINK_NODE = 'rawlogs:link';

// Dark theme colors (match base.scss).
const COLOR_BG_ODD = '#2a2a2a';
const COLOR_BG_EVEN = '#262626';
const COLOR_TEXT = '#e0e0e0';
const COLOR_PARTITION = '#666';
const COLOR_BORDER = '#444';

const EMPTY_VIEW = {
	logs: [],
	selected: '',
	paused: false,
	connectionError: false,
};

/**
 * Raw Logs Component.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function RawLogs( { headerControlsSlot } ) {
	// Mount the node graph; it returns the thin control callbacks.
	const { selectLog, setPaused } = useRawLogsGraph();

	// Low-frequency view model (dropdown + pause button + selected value).
	const view = useNodeState( VIEW_NODE, 'view' ) ?? EMPTY_VIEW;
	const {
		logs: availableLogs,
		selected: selectedLog,
		paused: isPaused,
		connectionError,
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
	// Cheap rAF-pushed state: LPS + counts (row DATA is not React state).
	const [ linesPerSecond, setLinesPerSecond ] = useState( 0 );
	const [ totalCount, setTotalCount ] = useState( 0 );
	const [ visibleCount, setVisibleCount ] = useState( 0 );

	const containerRef = useRef( null );
	const canvasRef = useRef( null );
	const scrollRef = useRef( null );
	const spacerRef = useRef( null );
	const offsetRef = useRef( 0 );
	const scrollTopRef = useRef( 0 );
	const isAdjustingScrollRef = useRef( false );
	const rafRef = useRef( null );
	// Last visible-row count; drives spacer-height (grow/filter/clear).
	const lastVisibleCountRef = useRef( 0 );
	// Newest visible row id (MONOTONIC): detects new arrivals past the cap.
	const lastTopIdRef = useRef( 0 );
	// Filter `lastTopIdRef` was measured under; a filter toggle re-baselines.
	const lastTopFilterRef = useRef( '' );
	// Last state pushed to React; idle frames push nothing, no re-render.
	const pushedRef = useRef( {
		total: -1,
		visible: -1,
		filter: null,
		lps: -1,
	} );
	// Filter kept in a ref so the rAF reads the latest without re-subscribing.
	const filterRef = useRef( filter );
	filterRef.current = filter;
	// Last time SseIn saw a frame/heartbeat; drives "Xs ago", synced each rAF.
	const lastEventTimeRef = useRef( null );

	// Ticking "Xs ago" display.
	const [ now, setNow ] = useState( Date.now() );
	useEffect( () => {
		const id = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( id );
	}, [] );
	const staleSec = lastEventTimeRef.current
		? Math.max( 0, Math.floor( ( now - lastEventTimeRef.current ) / 1000 ) )
		: null;

	// Canvas loop: reads the ring's visible window each frame; pushes counts.
	useEffect( () => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if ( ! canvas || ! container ) {
			return;
		}

		const ctx = canvas.getContext( '2d' );
		const dpr = window.devicePixelRatio || 1;
		let width = 0;
		let height = 0;

		// Resize canvas to match container.
		const resize = () => {
			const rect = container.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			canvas.width = width * dpr;
			canvas.height = height * dpr;
			canvas.style.width = width + 'px';
			canvas.style.height = height + 'px';
			ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );
			ctx.font = FONT;
		};
		resize();
		window.addEventListener( 'resize', resize );

		const draw = () => {
			// Read counts+LPS off the ring; lineAt reads only on-screen rows.
			const node = Core.node( VIEW_NODE );
			const count = node?.linesCount ?? 0;
			const lps = node?.lps ?? 0;
			const activeFilter = filterRef.current;
			const filterLower = activeFilter.toLowerCase();

			// Filter: scan ring for matches; else draw off the ring (no copy).
			let filteredRows = null;
			let visible;
			if ( activeFilter ) {
				filteredRows = [];
				for ( let i = 0; i < count; i++ ) {
					const l = node.lineAt( i );
					if (
						l &&
						l.content.toLowerCase().includes( filterLower )
					) {
						filteredRows.push( l );
					}
				}
				visible = filteredRows.length;
			} else {
				visible = count;
			}

			// New rows via the MONOTONIC top-id, not the pinned count.
			const topRow = filteredRows ? filteredRows[ 0 ] : node?.lineAt( 0 );
			const topId = topRow ? topRow.id : 0;
			const filterChanged = activeFilter !== lastTopFilterRef.current;
			lastTopFilterRef.current = activeFilter;
			let newRows = 0;
			if ( ! filterChanged && topId > lastTopIdRef.current ) {
				newRows = filteredRows
					? ( () => {
							const firstOld = filteredRows.findIndex(
								( r ) => r.id <= lastTopIdRef.current
							);
							return -1 === firstOld
								? filteredRows.length
								: firstOld;
					  } )()
					: Math.min( visible, topId - lastTopIdRef.current );
			}
			lastTopIdRef.current = topId;

			lastEventTimeRef.current =
				Core.node( LINK_NODE )?.lastEventTime() ?? null;

			const isAtTop = scrollTopRef.current < ROW_HEIGHT;

			// Spacer height tracks the visible row count (caps at max).
			if (
				visible !== lastVisibleCountRef.current &&
				spacerRef.current
			) {
				spacerRef.current.style.height = visible * ROW_HEIGHT + 'px';
			}

			if ( newRows > 0 ) {
				if ( isAtTop ) {
					// Compensate offset — decay will smooth-scroll to 0.
					offsetRef.current -= newRows * ROW_HEIGHT;
				} else if ( scrollRef.current ) {
					// Maintain scroll position when scrolled down.
					isAdjustingScrollRef.current = true;
					const newScrollTop =
						scrollRef.current.scrollTop + newRows * ROW_HEIGHT;
					scrollRef.current.scrollTop = newScrollTop;
					scrollTopRef.current = newScrollTop;
				}
			}

			lastVisibleCountRef.current = visible;

			// Push cheap state ONLY on change; idle frames don't re-render.
			const pushed = pushedRef.current;
			if (
				count !== pushed.total ||
				visible !== pushed.visible ||
				activeFilter !== pushed.filter
			) {
				setTotalCount( count );
				setVisibleCount( visible );
				pushed.total = count;
				pushed.visible = visible;
				pushed.filter = activeFilter;
			}
			if ( lps !== pushed.lps ) {
				setLinesPerSecond( lps );
				pushed.lps = lps;
			}

			// Decay offset toward 0 (smooth scroll).
			if ( Math.abs( offsetRef.current ) > 0.5 ) {
				offsetRef.current += ( 0 - offsetRef.current ) * 0.01;
			} else if ( offsetRef.current !== 0 ) {
				offsetRef.current = 0;
			}

			const scrollTop = scrollTopRef.current;
			const offset = offsetRef.current;

			// Clear canvas.
			ctx.clearRect( 0, 0, width, height );

			if ( visible === 0 ) {
				ctx.fillStyle = COLOR_PARTITION;
				ctx.textAlign = 'center';
				ctx.fillText(
					isPaused
						? __( 'Paused', 'newspack-nodes' )
						: __( 'Waiting for log lines…', 'newspack-nodes' ),
					width / 2,
					height / 2
				);
				ctx.textAlign = 'left';
				rafRef.current = requestAnimationFrame( draw );
				return;
			}

			// Calculate visible range.
			const visibleStartPx = scrollTop - offset;
			const visibleEndPx = scrollTop + height - offset;

			const startIndex = Math.max(
				0,
				Math.floor( visibleStartPx / ROW_HEIGHT )
			);
			const endIndex = Math.min(
				visible,
				Math.ceil( visibleEndPx / ROW_HEIGHT ) + 1
			);

			// Draw visible lines: filtered array or ring (on-screen only).
			for ( let i = startIndex; i < endIndex; i++ ) {
				const line = filteredRows
					? filteredRows[ i ]
					: node.lineAt( i );
				if ( ! line ) {
					continue;
				}
				const y = i * ROW_HEIGHT - scrollTop + offset;

				// Row background.
				ctx.fillStyle = line.isEven ? COLOR_BG_EVEN : COLOR_BG_ODD;
				ctx.fillRect( 0, y, width, ROW_HEIGHT );

				// Partition border.
				ctx.fillStyle = COLOR_BORDER;
				ctx.fillRect( PARTITION_WIDTH - 1, y, 1, ROW_HEIGHT );

				// Partition text.
				ctx.fillStyle = COLOR_PARTITION;
				ctx.textAlign = 'right';
				ctx.fillText(
					'P' + line.partition,
					PARTITION_WIDTH - 6,
					y + 14
				);

				// Content text.
				ctx.fillStyle = COLOR_TEXT;
				ctx.textAlign = 'left';
				ctx.fillText( line.content, PARTITION_WIDTH + 8, y + 14 );
			}

			rafRef.current = requestAnimationFrame( draw );
		};

		rafRef.current = requestAnimationFrame( draw );

		return () => {
			cancelAnimationFrame( rafRef.current );
			window.removeEventListener( 'resize', resize );
		};
		// isPaused read in draw for the empty-state label; re-bind on change.
	}, [ isPaused ] );

	// Total scroll-spacer height; the rAF keeps it in sync (this is the seed).
	const totalHeight = visibleCount * ROW_HEIGHT;

	// Clear all lines — clears the node ring; the next frame reflects 0 lines.
	const handleClear = () => {
		const node = Core.node( VIEW_NODE );
		if ( node ) {
			node.lines = [];
		}
		lastVisibleCountRef.current = 0;
		lastTopIdRef.current = 0;
		pushedRef.current = {
			total: 0,
			visible: 0,
			filter: filterRef.current,
			lps: 0,
		};
		setTotalCount( 0 );
		setVisibleCount( 0 );
		offsetRef.current = 0;
		scrollTopRef.current = 0;
		if ( spacerRef.current ) {
			spacerRef.current.style.height = '0px';
		}
		if ( scrollRef.current ) {
			scrollRef.current.scrollTop = 0;
		}
	};

	// Controls strip portals into the hub header slot; undefined = inline.
	const controls = (
		<div className="newspack-nodes-toolbar">
			{ availableLogs.length === 0 && (
				<span className="newspack-nodes-raw-logs-status">
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
									totalCount,
									'newspack-nodes'
								),
								visibleCount,
								totalCount
						  )
						: sprintf(
								// translators: %d: number of lines.
								_n(
									'%d line',
									'%d lines',
									visibleCount,
									'newspack-nodes'
								),
								visibleCount
						  ) }
				</span>
				{ linesPerSecond > 0 && (
					<span className="newspack-nodes-toolbar-stats__rps">
						{ sprintf(
							// translators: %s: lines-per-second rate (one decimal place).
							__( '%s lines/s', 'newspack-nodes' ),
							linesPerSecond.toFixed( 1 )
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
			className="newspack-nodes-raw-logs"
			role="region"
			aria-label={ __( 'Raw logs', 'newspack-nodes' ) }
		>
			{ renderedControls }

			<ConnectionBanner
				connectionError={ connectionError }
				message={ __(
					'Connection lost. Reconnecting…',
					'newspack-nodes'
				) }
			/>

			<div
				className="newspack-nodes-raw-logs-canvas-container"
				ref={ containerRef }
			>
				<canvas
					ref={ canvasRef }
					className="newspack-nodes-raw-logs-canvas"
				/>
				<div
					className="newspack-nodes-raw-logs-scroll"
					ref={ scrollRef }
					onScroll={ ( e ) => {
						if ( isAdjustingScrollRef.current ) {
							isAdjustingScrollRef.current = false;
							return;
						}
						scrollTopRef.current = e.target.scrollTop;
					} }
				>
					<div ref={ spacerRef } style={ { height: totalHeight } } />
				</div>
			</div>
		</div>
	);
}

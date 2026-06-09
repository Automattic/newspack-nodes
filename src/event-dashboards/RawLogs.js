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

import { useState, useEffect, useRef } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { useRawLogsGraph } from './hooks/useRawLogsGraph';
import ConnectionBanner from '../shared/components/ConnectionBanner';
import DebugOverlay from '../debug-overlay/DebugOverlay';
import './styles/raw-logs.scss';

const ROW_HEIGHT = 18;
const PARTITION_WIDTH = 36;
const FONT = '12px monospace';
const VIEW_NODE = 'rawlogs:view';

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
 * @return {import('react').ReactElement} Rendered component.
 */
export default function RawLogs() {
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

	const [ filter, setFilter ] = useState( '' );
	// Cheap derived state pushed from the rAF at frame rate: lines/second plus the
	// two counts the header + spacer need (total rows in the ring, and how many
	// are visible after the filter). The row DATA is not React state — the canvas
	// reads its visible window straight off the ring node each frame.
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
	// Last visible-row count — drives spacer-height changes (grow/filter/clear).
	const lastVisibleCountRef = useRef( 0 );
	// Newest visible row id the rAF has seen. New arrivals are detected off this
	// MONOTONIC id (it climbs past the cap, unlike the pinned count) — driving both
	// staleness AND scroll compensation so they keep working once the buffer caps.
	const lastTopIdRef = useRef( 0 );
	// The filter `lastTopIdRef` was last measured under. Filtered and unfiltered
	// top-ids live in different id-spaces, so a filter toggle must re-baseline
	// (no phantom new rows) rather than diff across the two.
	const lastTopFilterRef = useRef( '' );
	// Last state we pushed to React — so idle frames (nothing changed) push no
	// new state and don't re-render.
	const pushedRef = useRef( {
		total: -1,
		visible: -1,
		filter: null,
		lps: -1,
	} );
	// Filter kept in a ref so the rAF reads the latest without re-subscribing.
	const filterRef = useRef( filter );
	filterRef.current = filter;
	// Last time the node buffer grew — drives the "Xs ago" staleness display
	// (a row arriving is one `msg` event, matching the old lastEventTime touch).
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

	// Canvas rendering loop. Reads the ring's visible window (linesCount/lineAt)
	// directly every frame and pushes the cheap derived state (counts + LPS) to React.
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
			// Read counts + LPS straight off the ring node each frame. Row data is
			// read by index (lineAt) only for the on-screen window below — never
			// the whole buffer — so the frame cost is O(rows-on-screen).
			const node = Core.node( VIEW_NODE );
			const count = node?.linesCount ?? 0;
			const lps = node?.lps ?? 0;
			const activeFilter = filterRef.current;
			const filterLower = activeFilter.toLowerCase();

			// With a filter active, materialize the matching rows (one O(ring)
			// scan, and ONLY while filtering). Unfiltered, draw straight off the
			// ring — no per-frame copy of the buffer.
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

			// New rows since last frame, detected off the MONOTONIC newest-visible
			// id — NOT the visible count, which pins at the cap and would make
			// `newRows` read 0 forever (freezing staleness AND stalling the
			// smooth-scroll so rows replace in place = jank). Mirrors Request Log.
			// A filter toggle switches id-spaces (filtered top-id <= unfiltered),
			// so re-baseline that frame instead of reporting phantom new rows.
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

			if ( newRows > 0 ) {
				lastEventTimeRef.current = Date.now();
			}

			const isAtTop = scrollTopRef.current < ROW_HEIGHT;

			// Spacer height tracks the visible row count (grows while filling,
			// shrinks on clear/filter; stable at the cap).
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

			// Push the cheap derived state ONLY when it changed (counts + LPS).
			// Skipping unchanged frames keeps idle frames from re-rendering React.
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

			// Draw visible lines — filtered array when filtering, else the ring
			// directly (lineAt is O(1), so this loop touches only on-screen rows).
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
		// isPaused is read inside draw for the empty-state label; re-bind on change.
	}, [ isPaused ] );

	// Total height for the scroll container (spacer); the rAF keeps the live
	// height in sync imperatively — this is the React-render seed.
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

	return (
		<div
			className="newspack-nodes-raw-logs"
			role="region"
			aria-label={ __( 'Raw logs', 'newspack-nodes' ) }
		>
			<div className="newspack-nodes-raw-logs-header">
				<h3>{ __( 'Raw Logs', 'newspack-nodes' ) }</h3>
				<div className="newspack-nodes-raw-logs-controls">
					{ availableLogs.length === 0 && (
						<span className="newspack-nodes-raw-logs-status">
							{ __( 'No logs available', 'newspack-nodes' ) }
						</span>
					) }
					{ availableLogs.length > 0 && (
						<select
							className="newspack-nodes-raw-logs-select"
							value={ selectedLog }
							onChange={ ( e ) => selectLog( e.target.value ) }
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
						className="newspack-nodes-raw-logs-search"
						placeholder={ __( 'Filter…', 'newspack-nodes' ) }
						value={ filter }
						onChange={ ( e ) => setFilter( e.target.value ) }
					/>

					<span className="newspack-nodes-raw-logs-stats">
						<span className="newspack-nodes-raw-logs-count">
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
							<span className="newspack-nodes-raw-logs-rps">
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
									color:
										staleSec > 10 ? '#dba617' : '#757575',
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
						className={ `newspack-nodes-raw-logs-btn ${
							isPaused ? 'paused' : ''
						}` }
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
						className="newspack-nodes-raw-logs-btn"
						onClick={ handleClear }
						title={ __( 'Clear all lines', 'newspack-nodes' ) }
					>
						{ __( 'Clear', 'newspack-nodes' ) }
					</button>
				</div>
			</div>

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

			<DebugOverlay storageKey="newspack-nodes:debug:rawlogs" />
		</div>
	);
}

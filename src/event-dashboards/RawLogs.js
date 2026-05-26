/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * Raw Logs Component — canvas-rendered real-time stream of log lines.
 *
 * This is a THIN view over the `rawlogs/*` node graph (mounted by
 * `useRawLogsGraph`). The graph owns all data: `rawlogs/stream` holds the SSE
 * connection, `rawlogs/transform` turns envelopes into rows, and `rawlogs/view`
 * holds the buffer + view model. This component only renders.
 *
 * Two read paths, matching the view node's two cadences:
 * - LOW frequency: `useNodeState('rawlogs/view','view')` for `{ logs, selected,
 *   paused }` (the dropdown, pause button, selected value).
 * - HIGH frequency: the canvas rAF reads `Core.node('rawlogs/view').lines` and
 *   `.lps` directly every frame — a busy stream never re-renders React per line.
 */

import { useState, useEffect, useRef, useMemo } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';

import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { useRawLogsGraph } from './hooks/useRawLogsGraph';
import ConnectionBanner from '../shared/components/ConnectionBanner';
import './styles/raw-logs.scss';

const ROW_HEIGHT = 18;
const PARTITION_WIDTH = 36;
const FONT = '12px monospace';
const VIEW_NODE = 'rawlogs/view';

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
	// LPS + the rendered line buffer, both fed from the rAF at frame rate (the
	// original re-rendered LPS per frame and the count per batch; per-frame for
	// both is visually identical and keeps everything in one cheap state push).
	const [ linesPerSecond, setLinesPerSecond ] = useState( 0 );
	const [ lines, setLines ] = useState( [] );

	const containerRef = useRef( null );
	const canvasRef = useRef( null );
	const scrollRef = useRef( null );
	const spacerRef = useRef( null );
	const offsetRef = useRef( 0 );
	const scrollTopRef = useRef( 0 );
	const isAdjustingScrollRef = useRef( false );
	const rafRef = useRef( null );
	const filteredLinesRef = useRef( [] );
	// Last rendered buffer length — drives the smooth/virtual scroll math each
	// frame (replaces the old per-batch newCount the SSE handler tracked).
	const lastRenderedCountRef = useRef( 0 );
	// Last state we pushed to React — so idle frames (nothing changed) push no
	// new refs and don't re-render. The original only setLines() on new rows.
	const pushedRef = useRef( { count: -1, filter: null, lps: -1 } );
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

	// Canvas rendering loop. Reads the high-volume buffer (node.lines) directly
	// every frame and pushes the cheap derived state (count + LPS) to React.
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
			// Read the high-volume buffer + LPS straight off the node each frame.
			const node = Core.node( VIEW_NODE );
			const buffer = node?.lines ?? [];
			const lps = node?.lps ?? 0;
			const filterLower = filterRef.current.toLowerCase();

			// New rows since last frame → drive scroll + staleness.
			const newCount = Math.max(
				0,
				buffer.length - lastRenderedCountRef.current
			);
			if ( newCount > 0 ) {
				lastEventTimeRef.current = Date.now();
			}

			// Snapshot (and filter) the buffer so a mid-frame append can't mutate
			// what we draw / count.
			const snapshot = filterRef.current
				? buffer.filter( ( l ) =>
						l.content.toLowerCase().includes( filterLower )
				  )
				: buffer.slice();

			// Visible-count delta in the filtered view, for scroll compensation.
			const visibleNewCount =
				snapshot.length - filteredLinesRef.current.length;
			const isAtTop = scrollTopRef.current < ROW_HEIGHT;

			filteredLinesRef.current = snapshot;

			if ( visibleNewCount > 0 ) {
				// Update spacer height before scroll adjust so scrollTop isn't clamped.
				if ( spacerRef.current ) {
					spacerRef.current.style.height =
						snapshot.length * ROW_HEIGHT + 'px';
				}
				if ( isAtTop ) {
					// Compensate offset — decay will smooth-scroll to 0.
					offsetRef.current -= visibleNewCount * ROW_HEIGHT;
				} else if ( scrollRef.current ) {
					// Maintain scroll position when scrolled down.
					isAdjustingScrollRef.current = true;
					const newScrollTop =
						scrollRef.current.scrollTop +
						visibleNewCount * ROW_HEIGHT;
					scrollRef.current.scrollTop = newScrollTop;
					scrollTopRef.current = newScrollTop;
				}
			} else if ( visibleNewCount < 0 && spacerRef.current ) {
				// Buffer shrank (Clear / log switch) — collapse the spacer too.
				spacerRef.current.style.height =
					snapshot.length * ROW_HEIGHT + 'px';
			}

			lastRenderedCountRef.current = buffer.length;

			// Push the cheap derived state ONLY when it changed — count rides
			// `lines`, plus LPS. Skipping unchanged frames keeps idle (and steady-
			// LPS) frames from re-rendering React, matching the original's
			// new-rows-only setLines() + settling smoothed LPS.
			const pushed = pushedRef.current;
			if (
				snapshot.length !== pushed.count ||
				filterRef.current !== pushed.filter
			) {
				setLines( snapshot );
				pushed.count = snapshot.length;
				pushed.filter = filterRef.current;
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

			const visibleLines = filteredLinesRef.current;
			const scrollTop = scrollTopRef.current;
			const offset = offsetRef.current;

			// Clear canvas.
			ctx.clearRect( 0, 0, width, height );

			if ( visibleLines.length === 0 ) {
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
				visibleLines.length,
				Math.ceil( visibleEndPx / ROW_HEIGHT ) + 1
			);

			// Draw visible lines.
			for ( let i = startIndex; i < endIndex; i++ ) {
				const line = visibleLines[ i ];
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

	// Filtered lines for React UI; canvas reads filteredLinesRef separately.
	const filteredLines = useMemo( () => {
		if ( ! filter ) {
			return lines;
		}
		const filterLower = filter.toLowerCase();
		return lines.filter( ( line ) =>
			line.content.toLowerCase().includes( filterLower )
		);
	}, [ lines, filter ] );

	// Total height for scroll container.
	const totalHeight = filteredLines.length * ROW_HEIGHT;

	// Clear all lines — clears the node buffer; the next frame reflects 0 lines.
	const handleClear = () => {
		const node = Core.node( VIEW_NODE );
		if ( node ) {
			node.lines = [];
		}
		filteredLinesRef.current = [];
		lastRenderedCountRef.current = 0;
		pushedRef.current = { count: 0, filter: filterRef.current, lps: 0 };
		setLines( [] );
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
											lines.length,
											'newspack-nodes'
										),
										filteredLines.length,
										lines.length
								  )
								: sprintf(
										// translators: %d: number of lines.
										_n(
											'%d line',
											'%d lines',
											filteredLines.length,
											'newspack-nodes'
										),
										filteredLines.length
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
		</div>
	);
}

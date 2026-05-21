/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * Raw Logs Component
 *
 * Real-time streaming view of raw log lines.
 * Uses SSE to multiplex all partitions into a single stream.
 * Canvas-based rendering for maximum performance.
 */

import {
	useState,
	useEffect,
	useRef,
	useCallback,
	useMemo,
} from '@wordpress/element';

import { getCommandClient } from '../shared/utils/commandClient';
import unwrapCommandResponse from '../shared/utils/unwrapCommandResponse';
import usePageVisibility from '../shared/hooks/usePageVisibility';
import useMessageStream from '../shared/hooks/useMessageStream';
import transformLogLine from './transformLogLine';
import './styles/raw-logs.scss';

const ROW_HEIGHT = 18;
const MAX_LINES = 100000;
const PARTITION_WIDTH = 36;
const FONT = '12px monospace';

// Dark theme colors (match base.scss).
const COLOR_BG_ODD = '#2a2a2a';
const COLOR_BG_EVEN = '#262626';
const COLOR_TEXT = '#e0e0e0';
const COLOR_PARTITION = '#666';
const COLOR_BORDER = '#444';

/**
 * Raw Logs Component.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function RawLogs() {
	const [ availableLogs, setAvailableLogs ] = useState( [] );
	const [ selectedLog, setSelectedLog ] = useState( '' );
	const [ lines, setLines ] = useState( [] );
	const [ filter, setFilter ] = useState( '' );
	const [ isPaused, setIsPaused ] = useState( false );
	const [ linesPerSecond, setLinesPerSecond ] = useState( 0 );
	const [ isLoadingLogs, setIsLoadingLogs ] = useState( true );

	const isPageVisible = usePageVisibility();

	// Fetch available logs on mount via CommandClient — raw-logs.firehose_logs
	// returns `[{key, label}]` mirroring the legacy /firehose/logs REST shape
	// (see Raw_Logs_CI::firehose_logs).
	useEffect( () => {
		getCommandClient()
			.send( { to: 'raw-logs', verb: 'firehose_logs' } )
			.then( ( message ) => {
				const logs = unwrapCommandResponse( message ) || [];
				setAvailableLogs( logs );
				// Select first available log by default.
				if ( logs.length > 0 && ! selectedLog ) {
					setSelectedLog( logs[ 0 ].key );
				}
				setIsLoadingLogs( false );
			} )
			.catch( () => {
				setIsLoadingLogs( false );
			} );
	}, [] ); // eslint-disable-line react-hooks/exhaustive-deps
	const containerRef = useRef( null );
	const canvasRef = useRef( null );
	const scrollRef = useRef( null );
	const spacerRef = useRef( null );
	const offsetRef = useRef( 0 );
	const scrollTopRef = useRef( 0 );
	const isAdjustingScrollRef = useRef( false );
	const rafRef = useRef( null );
	const linesBufferRef = useRef( [] );
	const lineCounterRef = useRef( 0 );
	const lastProcessedCountRef = useRef( 0 );
	const lineHistoryRef = useRef( [] );
	const smoothedLPS = useRef( 0 );
	const filteredLinesRef = useRef( [] );

	// Calculate lines per second over 10-second window.
	const updateLinesPerSecond = useCallback( ( newCount ) => {
		const now = Date.now();
		const windowMs = 10000;

		if ( newCount > 0 ) {
			lineHistoryRef.current.push( { time: now, count: newCount } );
		}

		lineHistoryRef.current = lineHistoryRef.current.filter(
			( entry ) => now - entry.time < windowMs
		);

		const totalInWindow = lineHistoryRef.current.reduce(
			( sum, entry ) => sum + entry.count,
			0
		);

		const LPS = totalInWindow / ( windowMs / 1000 );
		smoothedLPS.current += ( LPS - smoothedLPS.current ) * 0.1;
		setLinesPerSecond( smoothedLPS.current );
	}, [] );

	// Per-Message transform: each Message envelope on the unified
	// /messages/stream endpoint becomes one row in the buffer. Skips the
	// substrate's `connected` envelope (KEY=='connected') so the
	// dashboard doesn't render the slot/pid metadata as a log line.
	const handleMessage = useCallback( ( envelope ) => {
		if ( envelope[ 5 ] === 'connected' ) {
			return;
		}
		const row = transformLogLine( envelope );
		if ( ! row ) {
			return;
		}
		lineCounterRef.current += 1;
		linesBufferRef.current.unshift( {
			id: lineCounterRef.current,
			partition: row.p,
			content: row.line,
			isEven: lineCounterRef.current % 2 === 0,
		} );
		if ( linesBufferRef.current.length > MAX_LINES ) {
			linesBufferRef.current.length = MAX_LINES;
		}
	}, [] );

	// Reset state on reconnect.
	const handleBeforeConnect = useCallback( () => {
		lineHistoryRef.current = [];
	}, [] );

	// Use unified message-stream connection hook.
	const {
		error,
		connect,
		close: closeSource,
		lastEventTime,
	} = useMessageStream( {
		subscriptions: selectedLog ? [ selectedLog ] : [],
		onMessage: handleMessage,
		onBeforeConnect: handleBeforeConnect,
	} );

	// Ticking "Xs ago" display.
	const [ now, setNow ] = useState( Date.now() );
	useEffect( () => {
		const id = setInterval( () => setNow( Date.now() ), 1000 );
		return () => clearInterval( id );
	}, [] );
	const staleSec = lastEventTime
		? Math.max( 0, Math.floor( ( now - lastEventTime ) / 1000 ) )
		: null;

	// Handle log selection change.
	const handleLogChange = useCallback( ( e ) => {
		const newLog = e.target.value;
		setSelectedLog( newLog );
		linesBufferRef.current = [];
		lineCounterRef.current = 0;
		lastProcessedCountRef.current = 0;
		// Canvas reads from filteredLinesRef directly — clearing the buffer
		// + state isn't enough; the 100ms ticker only refreshes the snapshot
		// when newCount > 0, so without this we keep drawing the old log's
		// lines until new ones arrive on the new log.
		filteredLinesRef.current = [];
		setLines( [] );
		offsetRef.current = 0;
		scrollTopRef.current = 0;
		if ( spacerRef.current ) {
			spacerRef.current.style.height = '0px';
		}
		if ( scrollRef.current ) {
			scrollRef.current.scrollTop = 0;
		}
		lineHistoryRef.current = [];
		setLinesPerSecond( 0 );
	}, [] );

	// Canvas rendering loop.
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
					isPaused ? 'Paused' : 'Waiting for log lines...',
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
	}, [ isPaused ] );

	// Batch UI updates - lines are newest-first.
	useEffect( () => {
		const timer = setInterval( () => {
			const newCount =
				lineCounterRef.current - lastProcessedCountRef.current;

			if ( newCount > 0 ) {
				const buffer = linesBufferRef.current;
				const newLines = buffer.slice( 0, newCount );
				const filterLower = filter.toLowerCase();

				const visibleNewCount = filter
					? newLines.filter( ( l ) =>
							l.content.toLowerCase().includes( filterLower )
					  ).length
					: newCount;

				const isAtTop = scrollTopRef.current < ROW_HEIGHT;

				// Snapshot the buffer so SSE can't mutate what draw() sees.
				if ( filter ) {
					filteredLinesRef.current = buffer.filter( ( l ) =>
						l.content.toLowerCase().includes( filterLower )
					);
				} else {
					filteredLinesRef.current = buffer.slice();
				}

				if ( visibleNewCount > 0 ) {
					// Update spacer height BEFORE scroll adjustment so
					// the browser does not clamp scrollTop to the old max.
					if ( spacerRef.current ) {
						spacerRef.current.style.height =
							filteredLinesRef.current.length * ROW_HEIGHT + 'px';
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
				}

				// Update state for UI counts.
				setLines( buffer );

				lastProcessedCountRef.current = lineCounterRef.current;
			}

			updateLinesPerSecond( newCount );
		}, 100 );

		return () => clearInterval( timer );
	}, [ filter, updateLinesPerSecond ] );

	// Handle page visibility and log changes.
	useEffect( () => {
		if ( isPageVisible && ! isPaused && selectedLog ) {
			connect();
		} else {
			closeSource();
		}
		return () => closeSource();
	}, [ isPageVisible, isPaused, selectedLog, connect, closeSource ] );

	// Filtered lines for React UI (counts, spacer height).
	// Canvas reads from filteredLinesRef (set only in setInterval).
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

	// Clear all lines.
	const handleClear = () => {
		linesBufferRef.current = [];
		lineCounterRef.current = 0;
		lastProcessedCountRef.current = 0;
		// Canvas reads from filteredLinesRef directly. The 100ms ticker
		// only refreshes the snapshot when newCount > 0; after Clear,
		// newCount stays 0 until new lines arrive, so without this the
		// canvas keeps drawing the pre-clear lines.
		filteredLinesRef.current = [];
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
			className="event-logger-raw-logs"
			role="region"
			aria-label="Raw logs"
		>
			<div className="event-logger-raw-logs-header">
				<h3>Raw Logs</h3>
				<div className="event-logger-raw-logs-controls">
					{ isLoadingLogs && (
						<span className="event-logger-raw-logs-status">
							Loading...
						</span>
					) }
					{ ! isLoadingLogs && availableLogs.length === 0 && (
						<span className="event-logger-raw-logs-status">
							No logs available
						</span>
					) }
					{ ! isLoadingLogs && availableLogs.length > 0 && (
						<select
							className="event-logger-raw-logs-select"
							value={ selectedLog }
							onChange={ handleLogChange }
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
						className="event-logger-raw-logs-search"
						placeholder="Filter..."
						value={ filter }
						onChange={ ( e ) => setFilter( e.target.value ) }
					/>

					<span className="event-logger-raw-logs-stats">
						<span className="event-logger-raw-logs-count">
							{ filteredLines.length }
							{ filter && ` / ${ lines.length }` } lines
						</span>
						{ linesPerSecond > 0 && (
							<span className="event-logger-raw-logs-rps">
								{ linesPerSecond.toFixed( 1 ) } lines/s
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
								{ staleSec }s ago
							</span>
						) }
					</span>

					<button
						className={ `event-logger-raw-logs-btn ${
							isPaused ? 'paused' : ''
						}` }
						onClick={ () => setIsPaused( ! isPaused ) }
						title={
							isPaused ? 'Resume streaming' : 'Pause streaming'
						}
					>
						{ isPaused ? '▶' : '⏸' }
					</button>

					<button
						className="event-logger-raw-logs-btn"
						onClick={ handleClear }
						title="Clear all lines"
					>
						Clear
					</button>
				</div>
			</div>

			{ error && (
				<div className="event-logger-raw-logs-error">{ error }</div>
			) }

			<div
				className="event-logger-raw-logs-canvas-container"
				ref={ containerRef }
			>
				<canvas
					ref={ canvasRef }
					className="event-logger-raw-logs-canvas"
				/>
				<div
					className="event-logger-raw-logs-scroll"
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

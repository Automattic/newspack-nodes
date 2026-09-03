/* global requestAnimationFrame, cancelAnimationFrame */

/**
 * The shared, ring-aware DOM-virtualized log list the substrate's log-stream
 * dashboards render their rows through (Partition Viewer, Log Viewer).
 *
 * It reads a ring-backed view node (`linesCount` + `lineAt( i )`, newest first,
 * both O(1)) and pulls ONLY the on-screen window each animation frame, so a
 * 100k-row ring costs O(rows on screen) per frame and the rows never become
 * React state. The window bounds come from scroll geometry read live inside
 * that frame rather than from `useVirtualization`, whose deferred scroll-state
 * re-render lands a frame behind the pull it would have to feed. New rows glide
 * into place behind an offset that decays to zero, or hold the reader's
 * position when they land above someone scrolled into history. Filtering
 * happens at INGEST on the view node, so the ring holds only what is displayed
 * and this windows straight off it.
 *
 * Per-frame work is bounded by the VIEWPORT rather than the input rate, the
 * flood discipline the console's `DumperNode` carries. The glide debt is
 * capped at MAX_DEBT_ROWS, stats publishes coalesce to STATS_INTERVAL_MS, and
 * row elements re-map only when the model commits.
 */

import { useState, useEffect, useRef, useMemo } from '@wordpress/element';
import './LogRowList.scss';

/** Rows pulled past each edge of the viewport, so a scroll shows no gap. */
const OVERSCAN = 5;

/**
 * Scroll depth, in row heights, under which new rows resume gliding.
 *
 * It pairs with STOP_GLIDE_ROWS as hysteresis, the stop threshold sitting at
 * twice the resume threshold: on a single threshold a reader hovering at the
 * boundary flips between gliding and scroll-anchoring every frame.
 */
const RESUME_GLIDE_ROWS = 1;

/**
 * Scroll depth, in row heights, past which gliding stops and new rows anchor
 * `scrollTop` instead. The upper half of the hysteresis band.
 */
const STOP_GLIDE_ROWS = 2;

/**
 * Rows of smooth-scroll debt a flood may queue — the glide budget.
 *
 * Uncapped, a firehose accrues debt faster than the 1%-per-frame decay clears
 * it (50k lines/s settles near 88k rows), which pushes the window past the ring
 * — a blank viewport — and churns hundreds of rows per frame. Past the budget
 * the excess appears instantly: the data always shows and only the animation
 * drops — the MemorySieve degrade the console's `DumperNode` makes under the
 * same pressure.
 */
const MAX_DEBT_ROWS = 300;

/** Stats publish cadence, coalescing toolbar re-renders off the frame rate. */
const STATS_INTERVAL_MS = 250;

/**
 * Newest rows the debug regime renders. They take their natural height and are
 * not virtualized, so this cap is what bounds the DOM cost.
 */
export const DEBUG_MAX_ROWS = 500;

/**
 * The ring-backed view node this list windows over.
 *
 * @typedef  {Object}                LogRowSource
 * @property {number}                linesCount Rows the ring holds.
 * @property {(i: number) => Object} lineAt     One row, by newest-first index.
 * @property {number}                [lps]      Lines per second, when the view node measures one.
 */

/**
 * The committed render model: the pulled window plus the geometry placing it.
 *
 * Every field is written together on a model commit, so the rows and the
 * geometry describing them can never disagree by a frame.
 *
 * @typedef  {Object}   LogRowModel
 * @property {Object[]} rows        The pulled window, newest first.
 * @property {number}   spacerTop   Height in px of the spacer standing in for the rows above the window.
 * @property {number}   totalHeight Full scroll height in px; 0 in the debug regime, which is unvirtualized.
 * @property {number}   visible     Rows the ring holds. It sizes `totalHeight`
 *                                  and gates the empty state, so it stays the
 *                                  full count in the debug regime, where only
 *                                  DEBUG_MAX_ROWS of them render.
 * @property {number}   [offset]    Smooth-scroll offset in px, committed with its rows. Absent in the debug regime, which never glides.
 */

/**
 * The counts the list reports up to the consumer's toolbar.
 *
 * @typedef  {Object} LogRowStats
 * @property {number} total   Rows the ring holds.
 * @property {number} visible Rows on display: the ring total, or the DEBUG_MAX_ROWS cap in the debug regime.
 * @property {number} lps     Lines per second, passed through from the view node; an idle stream decays to 0.
 */

/**
 * One-row renderer: the element standing in for a row of the pulled window.
 *
 * It is handed straight to `Array.map`, so the window index and the window
 * array follow the row — unread by contract, and that index is the WINDOW's,
 * not the ring's.
 *
 * @callback RenderRow
 * @param {Object} row One row, as the view node yields it from the ring.
 * @return {import('react').ReactElement} The rendered row; it must set its own
 *   key, and keep a stable identity or row memoization drops.
 */

/**
 * @param {Object}                       props
 * @param {() => LogRowSource|null}      props.getNode         Read fresh each frame, so a graph rebuild is picked up.
 * @param {number}                       props.rowHeight       Fixed row height in px; every window bound is computed from it.
 * @param {RenderRow}                    props.renderRow       Renders one row of the pulled window.
 * @param {*}                            [props.emptyLabel]    Rendered in place of the rows while the ring is empty.
 * @param {(stats: LogRowStats) => void} [props.onStats]       Called on change, and no more often than STATS_INTERVAL_MS.
 * @param {number}                       [props.resetSignal]   Change it to rebase the projection (a clear, or a new subscription).
 * @param {string}                       [props.listClassName] Extra class on the scroll container.
 * @param {boolean}                      [props.debug]         Unvirtualized debug regime: the newest DEBUG_MAX_ROWS rows at natural height.
 * @return {import('react').ReactElement} The virtualized list.
 */
export default function LogRowList( {
	getNode,
	rowHeight,
	renderRow,
	emptyLabel = '',
	onStats,
	resetSignal = 0,
	listClassName = '',
	debug = false,
} ) {
	const listRef = useRef( null );
	const contentRef = useRef( null );
	const offsetRef = useRef( 0 );
	const rafRef = useRef( null );
	// Hysteresis state: whether new rows glide (true) or anchor scrollTop.
	const glidingRef = useRef( true );
	// Newest row id already glided for. Ids climb even when the ring is full.
	const lastTopIdRef = useRef( 0 );
	// The latest `onStats`, so the frame reads it without re-subscribing.
	const onStatsRef = useRef( onStats );
	onStatsRef.current = onStats;
	// Change-detect gate: idle frames push no React state.
	const modelPushedRef = useRef( {
		visible: -1,
		start: -1,
		end: -1,
		topId: -1,
		node: null,
	} );
	// Change-detect AND time-throttled (STATS_INTERVAL_MS since `at`).
	const statsPushedRef = useRef( {
		total: -1,
		visible: -1,
		lps: -1,
		at: -Infinity,
	} );

	const [ model, setModel ] = useState(
		/** @type {LogRowModel} */ ( {
			rows: [],
			spacerTop: 0,
			totalHeight: 0,
			visible: 0,
			offset: 0,
		} )
	);

	// Rebase on clear: forget the motion and the new-row baseline.
	useEffect( () => {
		lastTopIdRef.current = 0;
		offsetRef.current = 0;
		glidingRef.current = true;
		modelPushedRef.current = {
			visible: -1,
			start: -1,
			end: -1,
			topId: -1,
			node: null,
		};
		if ( contentRef.current ) {
			contentRef.current.style.transform = '';
		}
		if ( listRef.current ) {
			listRef.current.scrollTop = 0;
		}
	}, [ resetSignal ] );

	useEffect( () => {
		/**
		 * One frame: read the ring, advance the glide, and commit a model when
		 * the window it renders changed.
		 *
		 * It re-arms on every exit path, so the debug branch's early return
		 * cannot drop the loop.
		 *
		 * @param {number} frameTs This frame's timestamp, as rAF hands it over.
		 */
		const draw = ( frameTs ) => {
			const node = getNode();
			const total = node?.linesCount ?? 0;
			const lps = node?.lps ?? 0;

			/**
			 * Report the counts up, on change AND on cadence.
			 *
			 * A change throttled inside the interval is not queued: the first
			 * frame past the interval publishes whatever is current then.
			 *
			 * @param {number} visibleNow Rows on display this frame.
			 */
			const pushStats = ( visibleNow ) => {
				const s = statsPushedRef.current;
				if (
					( total !== s.total ||
						visibleNow !== s.visible ||
						lps !== s.lps ) &&
					frameTs - s.at >= STATS_INTERVAL_MS
				) {
					s.total = total;
					s.visible = visibleNow;
					s.lps = lps;
					s.at = frameTs;
					onStatsRef.current?.( { total, visible: visibleNow, lps } );
				}
			};

			// Ingest filters, so the display count is the ring total.
			const visible = total;

			// Monotonic top id: it detects new rows, and a full ring rotating.
			const topRow = node?.lineAt( 0 );
			const topId = topRow ? topRow.id : 0;

			// First sight of a full ring baselines it — never glides it.
			if ( 0 === lastTopIdRef.current && topId > 0 ) {
				lastTopIdRef.current = topId;
			}

			// Debug: the newest rows, natural height, no window math.
			if ( debug ) {
				// Baseline stays current: leaving debug must not replay these.
				lastTopIdRef.current = topId;
				// Pending glide debt dies here too, or exit replays it.
				offsetRef.current = 0;
				const end = Math.min( visible, DEBUG_MAX_ROWS );
				// Report what debug actually shows; the toolbar reads x/total.
				pushStats( end );
				const pushed2 = modelPushedRef.current;
				if (
					node !== pushed2.node ||
					visible !== pushed2.visible ||
					end !== pushed2.end ||
					topId !== pushed2.topId
				) {
					const debugRows = [];
					for ( let i = 0; i < end; i++ ) {
						const row = node.lineAt( i );
						if ( row ) {
							debugRows.push( row );
						}
					}
					pushed2.node = node;
					pushed2.visible = visible;
					pushed2.start = 0;
					pushed2.end = end;
					pushed2.topId = topId;
					setModel( {
						rows: debugRows,
						spacerTop: 0,
						totalHeight: 0,
						visible,
					} );
				}
				rafRef.current = requestAnimationFrame( draw );
				return;
			}

			let newRows = 0;
			if ( topId > lastTopIdRef.current ) {
				newRows = Math.min( visible, topId - lastTopIdRef.current );
			}
			lastTopIdRef.current = topId;

			const list = listRef.current;
			if ( list ) {
				if ( list.scrollTop >= rowHeight * STOP_GLIDE_ROWS ) {
					glidingRef.current = false;
				} else if ( list.scrollTop < rowHeight * RESUME_GLIDE_ROWS ) {
					glidingRef.current = true;
				}
			}
			const isAtTop = ! list || glidingRef.current;
			if ( newRows > 0 ) {
				if ( isAtTop ) {
					// Hold rows in place; the offset decays smoothly to 0.
					offsetRef.current -= newRows * rowHeight;
				} else if ( list ) {
					// @longform Hold the reader's position when scrolled into
					// history. Exact, because `overflow-anchor: none` stops the
					// browser correcting for the same rows a second time; with
					// anchoring on both corrections land and every new row
					// moves the reader by two.
					list.scrollTop += newRows * rowHeight;
				}
			}

			// Clamp to the glide budget so the window cannot outrun the ring.
			const maxDebt = MAX_DEBT_ROWS * rowHeight;
			if ( offsetRef.current < -maxDebt ) {
				offsetRef.current = -maxDebt;
			}

			// Decay the smooth-scroll offset toward 0.
			if ( Math.abs( offsetRef.current ) > 0.5 ) {
				offsetRef.current += ( 0 - offsetRef.current ) * 0.01;
			} else if ( 0 !== offsetRef.current ) {
				offsetRef.current = 0;
			}

			pushStats( visible );

			// Window bounds from live geometry; pull ONLY those rows.
			const scrollTop = list ? list.scrollTop : 0;
			const height = list ? list.clientHeight : 0;
			const offset = offsetRef.current;
			// @longform Bind the ring into the window: the viewport's shifted
			// range plus the glide path the 1%/frame decay travels over the
			// next ~8 frames (~8% of the debt) — revealed rows stay painted.
			// The clamp bounds debtRows to MAX_DEBT_ROWS, so this tops at ~24.
			const debtRows = Math.max( 0, Math.floor( -offset / rowHeight ) );
			const debtPaint = Math.ceil( debtRows * 0.08 );
			const start = Math.max(
				0,
				Math.floor( ( scrollTop - offset ) / rowHeight ) -
					OVERSCAN -
					debtPaint
			);
			const end = Math.min(
				visible,
				Math.ceil( ( scrollTop + height - offset ) / rowHeight ) +
					OVERSCAN
			);

			const pushed = modelPushedRef.current;
			if (
				node !== pushed.node ||
				visible !== pushed.visible ||
				start !== pushed.start ||
				end !== pushed.end ||
				topId !== pushed.topId
			) {
				const rows = [];
				for ( let i = start; i < end; i++ ) {
					const row = node.lineAt( i );
					if ( row ) {
						rows.push( row );
					}
				}
				pushed.node = node;
				pushed.visible = visible;
				pushed.start = start;
				pushed.end = end;
				pushed.topId = topId;
				// The offset commits with its rows; it never leads them.
				setModel( {
					rows,
					spacerTop: start * rowHeight,
					totalHeight: visible * rowHeight,
					visible,
					offset: offsetRef.current,
				} );
			} else if ( contentRef.current ) {
				// Decay-only frame: the painted glide path absorbs the nudge.
				contentRef.current.style.transform = offsetRef.current
					? `translate3d(0,${ offsetRef.current }px,0)`
					: '';
			}

			rafRef.current = requestAnimationFrame( draw );
		};

		rafRef.current = requestAnimationFrame( draw );
		return () => cancelAnimationFrame( rafRef.current );
	}, [ getNode, rowHeight, debug ] );

	// Rows re-map only when the model commits, not on parent re-renders.
	const renderedRows = useMemo(
		() => model.rows.map( renderRow ),
		[ model, renderRow ]
	);

	return (
		<div
			className={ `newspack-nodes-table newspack-nodes-log-rows${
				debug ? ' is-debug' : ''
			}${ listClassName ? ' ' + listClassName : '' }` }
			role="rowgroup"
			ref={ listRef }
			style={
				/** @type {import('react').CSSProperties} */ ( {
					'--log-row-height': `${ rowHeight }px`,
				} )
			}
		>
			<div
				className="newspack-nodes-log-rows__content"
				ref={ contentRef }
				style={ {
					minHeight: model.totalHeight || undefined,
					transform: model.offset
						? `translate3d(0,${ model.offset }px,0)`
						: undefined,
				} }
			>
				{ 0 === model.visible ? (
					<div className="newspack-nodes-empty-state is-quiet newspack-nodes-log-rows__empty">
						{ emptyLabel }
					</div>
				) : (
					<>
						<div
							style={ {
								height: model.spacerTop,
								flexShrink: 0,
							} }
						/>
						{ renderedRows }
					</>
				) }
			</div>
		</div>
	);
}

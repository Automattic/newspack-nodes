/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * LogRowList — the shared, ring-aware DOM-virtualized log list.
 *
 * Consumes a ring-backed view node (`linesCount` + `lineAt(i)`, newest first, both
 * O(1)) and, each rAF frame, pulls ONLY the on-screen window via `lineAt(i)` — it
 * never materializes the whole ring, so a 100k buffer costs O(rows-on-screen) per
 * frame. The window bounds are computed inline from live scroll geometry (the
 * canvas renderer's algorithm) instead of `useVirtualization`, whose deferred
 * scroll-state re-render lags the single-frame pull. New rows smooth-scroll into
 * place via an offset that decays to zero (or hold the reader's position when
 * scrolled into history), and `{ total, visible, lps }` is reported up to the
 * consumer's toolbar. An optional `filter` scans the ring (only while active,
 * matching the canvas renderer) and windows over the matches.
 *
 * Flood-safe, per the console Dumper: per-frame work is bounded regardless of
 * INPUT RATE (the active-filter scan stays O(ring capacity), rate-independent).
 * The glide debt is capped at MAX_DEBT_ROWS (excess rows appear instantly —
 * the animation drops, never the data), stats publishes coalesce to
 * STATS_INTERVAL_MS, and row elements re-map only on a model commit.
 *
 * @param {Object}   props
 * @param {Function} props.getNode         `() => node|null`; node exposes `linesCount`, `lineAt(i)`, optional `lps`.
 * @param {number}   props.rowHeight       Fixed row height in px.
 * @param {Function} props.renderRow       `(row) => ReactElement` (must set its own key; keep the identity stable or row memoization drops).
 * @param {string}   [props.filter]        Substring filter; '' scans nothing.
 * @param {Function} [props.matchRow]      `(row, filterLower) => boolean`; defaults to `row.content` includes.
 * @param {*}        [props.emptyLabel]    Rendered when no rows are visible.
 * @param {Function} [props.onStats]       `({ total, visible, lps }) => void`, on change, coalesced to STATS_INTERVAL_MS.
 * @param {number}   [props.resetSignal]   Change it to rebase the projection (clear / new subscription).
 * @param {boolean}  [props.debug]         Unvirtualized debug regime: the newest DEBUG_MAX_ROWS rows at natural height.
 * @param {string}   [props.listClassName] Extra class on the scroll container.
 * @return {import('react').ReactElement} The virtualized list.
 */

import {
	useState,
	useEffect,
	useRef,
	useCallback,
	useMemo,
} from '@wordpress/element';
import './LogRowList.scss';

const OVERSCAN = 5;

// @longform Smooth-scroll hysteresis (upper = 2x lower): gliding STOPS once
// scrollTop passes STOP_GLIDE_ROWS row heights and only RESUMES back under
// RESUME_GLIDE_ROWS, so a reader hovering near the top can't flip between
// glide and scroll-anchor modes every frame.
const RESUME_GLIDE_ROWS = 1;
const STOP_GLIDE_ROWS = 2;

// @longform Glide budget: rows of smooth-scroll debt a flood may queue.
// Uncapped, a firehose accrues debt faster than the 1%/frame decay clears
// it (50k lines/s ≈ 88k rows steady-state), pushing the window past the
// ring (blank viewport) and churning hundreds of rows per frame. Past the
// budget the excess appears instantly — the data always shows, only the
// animation drops (MemorySieve degrade, per the console Dumper).
const MAX_DEBT_ROWS = 300;

// Stats publish cadence: coalesce toolbar re-renders off the frame rate.
const STATS_INTERVAL_MS = 250;

// Debug mode renders natural-height rows unvirtualized; bound the DOM cost.
export const DEBUG_MAX_ROWS = 500;

const defaultMatch = ( row, filterLower ) =>
	String( row?.content ?? '' )
		.toLowerCase()
		.includes( filterLower );

export default function LogRowList( {
	getNode,
	rowHeight,
	renderRow,
	filter = '',
	matchRow = defaultMatch,
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
	const isAdjustingScrollRef = useRef( false );
	// Hysteresis state: whether new rows glide (true) or anchor scrollTop.
	const glidingRef = useRef( true );
	// Newest row id already smooth-scrolled for (monotonic; cap-robust).
	const lastTopIdRef = useRef( 0 );
	const lastTopFilterRef = useRef( filter );
	// Latest of each so the rAF reads without re-subscribing.
	const filterRef = useRef( filter );
	filterRef.current = filter;
	const matchRef = useRef( matchRow );
	matchRef.current = matchRow;
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

	const [ model, setModel ] = useState( {
		rows: [],
		spacerTop: 0,
		totalHeight: 0,
		visible: 0,
		offset: 0,
	} );

	// Rebase on clear / filter change: forget motion + the new-row baseline.
	useEffect( () => {
		lastTopIdRef.current = 0;
		lastTopFilterRef.current = filterRef.current;
		offsetRef.current = 0;
		isAdjustingScrollRef.current = false;
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
	}, [ resetSignal, filter ] );

	useEffect( () => {
		const draw = ( frameTs ) => {
			const node = getNode();
			const total = node?.linesCount ?? 0;
			const lps = node?.lps ?? 0;
			const activeFilter = filterRef.current;
			const filterLower = activeFilter.toLowerCase();

			// On change AND on cadence; a throttled change lands next window.
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

			// Filter: scan the ring for matches; else window straight off it.
			let filtered = null;
			let visible;
			if ( activeFilter ) {
				filtered = [];
				for ( let i = 0; i < total; i++ ) {
					const row = node.lineAt( i );
					if ( row && matchRef.current( row, filterLower ) ) {
						filtered.push( row );
					}
				}
				visible = filtered.length;
			} else {
				visible = total;
			}

			// MONOTONIC top id: new-row detection AND the ring-rotation tell.
			const topRow = filtered ? filtered[ 0 ] : node?.lineAt( 0 );
			const topId = topRow ? topRow.id : 0;

			// Debug: the newest rows, natural height, no window math.
			if ( debug ) {
				// Baseline stays current: leaving debug must not replay these.
				lastTopIdRef.current = topId;
				lastTopFilterRef.current = activeFilter;
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
						const row = filtered ? filtered[ i ] : node.lineAt( i );
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

			const filterChanged = activeFilter !== lastTopFilterRef.current;
			lastTopFilterRef.current = activeFilter;
			let newRows = 0;
			if ( ! filterChanged && topId > lastTopIdRef.current ) {
				if ( filtered ) {
					const firstOld = filtered.findIndex(
						( r ) => r.id <= lastTopIdRef.current
					);
					newRows = -1 === firstOld ? filtered.length : firstOld;
				} else {
					newRows = Math.min( visible, topId - lastTopIdRef.current );
				}
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
					// Hold the reader's position when scrolled into history.
					isAdjustingScrollRef.current = true;
					list.scrollTop += newRows * rowHeight;
				}
			}

			// Clamp to the glide budget: excess appears instantly, never blank.
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
					const row = filtered ? filtered[ i ] : node.lineAt( i );
					if ( row ) {
						rows.push( row );
					}
				}
				pushed.node = node;
				pushed.visible = visible;
				pushed.start = start;
				pushed.end = end;
				pushed.topId = topId;
				// Offset commits WITH its rows: translate never leads window.
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

	// Swallow the programmatic scroll we make when holding the read position.
	const handleScroll = useCallback( () => {
		if ( isAdjustingScrollRef.current ) {
			isAdjustingScrollRef.current = false;
		}
	}, [] );

	// Rows re-map only when the model commits, not on parent re-renders.
	const renderedRows = useMemo(
		() => model.rows.map( renderRow ),
		[ model, renderRow ]
	);

	return (
		<div
			className={ `newspack-nodes-log-rows${ debug ? ' is-debug' : '' }${
				listClassName ? ' ' + listClassName : ''
			}` }
			role="rowgroup"
			ref={ listRef }
			onScroll={ handleScroll }
			style={ { '--log-row-height': `${ rowHeight }px` } }
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
					<div className="newspack-nodes-log-rows__empty">
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

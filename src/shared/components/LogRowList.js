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
 * @param {Object}   props
 * @param {Function} props.getNode         `() => node|null`; node exposes `linesCount`, `lineAt(i)`, optional `lps`.
 * @param {number}   props.rowHeight       Fixed row height in px.
 * @param {Function} props.renderRow       `(row) => ReactElement` (must set its own key).
 * @param {string}   [props.filter]        Substring filter; '' scans nothing.
 * @param {Function} [props.matchRow]      `(row, filterLower) => boolean`; defaults to `row.content` includes.
 * @param {*}        [props.emptyLabel]    Rendered when no rows are visible.
 * @param {Function} [props.onStats]       `({ total, visible, lps }) => void`, called only on change.
 * @param {number}   [props.resetSignal]   Change it to rebase the projection (clear / new subscription).
 * @param {boolean}  [props.debug]         Unvirtualized debug regime: the newest DEBUG_MAX_ROWS rows at natural height.
 * @param {string}   [props.listClassName] Extra class on the scroll container.
 * @return {import('react').ReactElement} The virtualized list.
 */

import { useState, useEffect, useRef, useCallback } from '@wordpress/element';
import './LogRowList.scss';

const OVERSCAN = 5;

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
	// Change-detect gates: idle frames push no React state / no onStats.
	const modelPushedRef = useRef( {
		visible: -1,
		start: -1,
		end: -1,
		node: null,
	} );
	const statsPushedRef = useRef( { total: -1, visible: -1, lps: -1 } );

	const [ model, setModel ] = useState( {
		rows: [],
		spacerTop: 0,
		totalHeight: 0,
		visible: 0,
	} );

	// Rebase on clear / filter change: forget motion + the new-row baseline.
	useEffect( () => {
		lastTopIdRef.current = 0;
		lastTopFilterRef.current = filterRef.current;
		offsetRef.current = 0;
		isAdjustingScrollRef.current = false;
		modelPushedRef.current = {
			visible: -1,
			start: -1,
			end: -1,
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
		const draw = () => {
			const node = getNode();
			const total = node?.linesCount ?? 0;
			const lps = node?.lps ?? 0;
			const activeFilter = filterRef.current;
			const filterLower = activeFilter.toLowerCase();

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

			// Debug: the newest rows, natural height, no window math.
			if ( debug ) {
				const end = Math.min( visible, DEBUG_MAX_ROWS );
				const s2 = statsPushedRef.current;
				if (
					total !== s2.total ||
					visible !== s2.visible ||
					lps !== s2.lps
				) {
					s2.total = total;
					s2.visible = visible;
					s2.lps = lps;
					onStatsRef.current?.( { total, visible, lps } );
				}
				const pushed2 = modelPushedRef.current;
				if (
					node !== pushed2.node ||
					visible !== pushed2.visible ||
					end !== pushed2.end
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

			// New rows via the MONOTONIC top id (survives the ring cap/pin).
			const topRow = filtered ? filtered[ 0 ] : node?.lineAt( 0 );
			const topId = topRow ? topRow.id : 0;
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
			const isAtTop = ! list || list.scrollTop < rowHeight;
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

			// Decay the smooth-scroll offset toward 0.
			if ( Math.abs( offsetRef.current ) > 0.5 ) {
				offsetRef.current += ( 0 - offsetRef.current ) * 0.01;
			} else if ( 0 !== offsetRef.current ) {
				offsetRef.current = 0;
			}
			if ( contentRef.current ) {
				contentRef.current.style.transform = offsetRef.current
					? `translate3d(0,${ offsetRef.current }px,0)`
					: '';
			}

			// Report stats up only when they change (idle frames stay quiet).
			const s = statsPushedRef.current;
			if ( total !== s.total || visible !== s.visible || lps !== s.lps ) {
				s.total = total;
				s.visible = visible;
				s.lps = lps;
				onStatsRef.current?.( { total, visible, lps } );
			}

			// Window bounds from live geometry; pull ONLY those rows.
			const scrollTop = list ? list.scrollTop : 0;
			const height = list ? list.clientHeight : 0;
			const offset = offsetRef.current;
			const start = Math.max(
				0,
				Math.floor( ( scrollTop - offset ) / rowHeight ) - OVERSCAN
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
				end !== pushed.end
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
				setModel( {
					rows,
					spacerTop: start * rowHeight,
					totalHeight: visible * rowHeight,
					visible,
				} );
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
				style={ { minHeight: model.totalHeight || undefined } }
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
						{ model.rows.map( renderRow ) }
					</>
				) }
			</div>
		</div>
	);
}

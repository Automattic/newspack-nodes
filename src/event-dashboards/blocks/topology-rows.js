/**
 * The topology-rows block: one `TopologyRow` per active topology, foldable
 * between a compact summary and the full live detail tree, under a fold-all
 * and unfold-all toolbar, then a de-emphasized strip of the stopped ones,
 * each with its activate, restart and edit controls; a refused or warned
 * mutation raises an alert.
 *
 * It is its own block because a live tree with mutations lies outside every
 * shared block: a row is a topology's graph, its workers and its segments, and
 * its controls write.
 *
 * Rows sit in the reader's drag order, never in health order, so a flapping
 * "behind" badge cannot reshuffle the list under the pointer; that order and
 * the fold state persist through `overviewPrefs`. A drag floats the row
 * through a CSS transform, one pass a frame, and commits once on drop; while
 * it does, every source on the page holds still (`useSourcesPaused`), so no
 * poll asks and no tile, chart or row redraws. While its layout is edited, every control
 * writes nothing.
 */

import { useState, useEffect, useRef, useCallback } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useEditing } from '@newspack-nodes/shared/composition/page';
import { useSourcesPaused } from '@newspack-nodes/shared/sources';
import TopologyControls from '../TopologyControls';
import AlertModal from '../AlertModal';
import { useTopologyManager } from '../hooks/useTopologyManager';
import { consoleHref, TopologyRow } from '../TopologyRow';
import {
	orderTopologies,
	dragReorder,
	dragGapTransforms,
	mergeStoredOrder,
} from '../overviewOrder';
import {
	readOrder,
	writeOrder,
	readExpanded,
	writeExpanded,
	readCollapsed,
	writeCollapsed,
} from '../overviewPrefs';
import '../styles/overview.scss';

/** Does nothing, as a mutation does while its layout is edited. */
const nothing = () => {};

/**
 * The block's rendered active rows, in display order.
 *
 * @param {{current: ?HTMLElement}} rootRef The block's root.
 * @return {Element[]} The rows.
 */
const rowElements = ( rootRef ) => [
	...( rootRef.current?.querySelectorAll(
		'.nodes-overview__rows [data-topology-row]'
	) ?? [] ),
];

/**
 * The rendered active rows' vertical bounds, in display order — the geometry
 * `dragGapTransforms` and `dragReorder` resolve a drag's target slot against.
 * Order is load-bearing: both align `rects[i]` with the name at index `i`.
 *
 * @param {{current: ?HTMLElement}} rootRef The block's root.
 * @return {Array<{name:string,top:number,bottom:number}>} Per-row name and bounds.
 */
function activeRowRects( rootRef ) {
	return rowElements( rootRef ).map( ( el ) => {
		const r = el.getBoundingClientRect();
		return {
			name: el.getAttribute( 'data-topology-row' ),
			top: r.top,
			bottom: r.bottom,
		};
	} );
}

/**
 * The block.
 *
 * @return {import('react').ReactElement} The rows.
 */
function View() {
	const rootRef = useRef( null );
	const editing = useEditing();
	// Drag state (FIRST, to pause all else); float = no React render per move.
	const [ dragName, setDragName ] = useState( null );
	const dragNameRef = useRef( null );
	// rAF-coalesce pointer moves: store latest Y, apply once per frame.
	const dragRafRef = useRef( null );
	const dragYRef = useRef( 0 );
	// Drag geometry cached at pointer-down (transforms don't change layout).
	const dragStartYRef = useRef( 0 );
	const dragElsRef = useRef( [] );
	const dragRectsRef = useRef( [] );
	const dragNamesRef = useRef( [] );
	const dragFromRef = useRef( -1 );
	const dragging = null !== dragName;

	// A refusal ({name,message}) or an activation's warning raises this alert.
	const [ alert, setAlert ] = useState( null );
	const onWarning = useCallback(
		( warning ) => setAlert( { ...warning, warning: true } ),
		[]
	);

	const { topologies, activate, deactivate, restart } = useTopologyManager( {
		onError: setAlert,
		onWarning,
	} );
	// A drag holds every source on the page, so nothing moves mid-gesture.
	useSourcesPaused( dragging );
	// Active topology names currently UNFOLDED, restored from localStorage.
	const [ expanded, setExpanded ] = useState( readExpanded );
	const [ order, setOrder ] = useState( readOrder );
	const [ collapsed, setCollapsed ] = useState( readCollapsed );

	useEffect( () => writeExpanded( expanded ), [ expanded ] );
	useEffect( () => writeCollapsed( collapsed ), [ collapsed ] );
	useEffect( () => writeOrder( order ), [ order ] );
	// Cancel a pending drag frame if we unmount mid-drag.
	useEffect(
		() => () => {
			if ( null !== dragRafRef.current ) {
				window.cancelAnimationFrame( dragRafRef.current );
			}
		},
		[]
	);

	const actives = topologies.filter( ( t ) => t.active );
	const stopped = topologies
		.filter( ( t ) => ! t.active )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) );

	// Display order = user's drag order, never health (no flap-reorder).
	const displayedNames = orderTopologies(
		actives.map( ( t ) => t.name ),
		order
	);
	const orderedActives = displayedNames
		.map( ( name ) => actives.find( ( t ) => t.name === name ) )
		.filter( Boolean );

	// Mirror display order into a ref so stable handlers let memo(Row) skip.
	const displayedRef = useRef( displayedNames );
	displayedRef.current = displayedNames;

	const expandTopology = useCallback(
		( name ) => setExpanded( ( prev ) => new Set( prev ).add( name ) ),
		[]
	);
	const collapseTopology = useCallback( ( name ) => {
		setExpanded( ( prev ) => {
			const next = new Set( prev );
			next.delete( name );
			return next;
		} );
	}, [] );
	const foldAll = () => setExpanded( new Set() );
	const unfoldAll = () =>
		setExpanded( new Set( actives.map( ( t ) => t.name ) ) );
	const onToggleFold = useCallback( ( key ) => {
		setCollapsed( ( prev ) => {
			const next = new Set( prev );
			if ( next.has( key ) ) {
				next.delete( key );
			} else {
				next.add( key );
			}
			return next;
		} );
	}, [] );

	// Pointer-drag reorder: grip captures pointer; float commits once on drop.
	const onGripPointerDown = useCallback( ( name, e ) => {
		e.preventDefault();
		// Capture so move/up keep firing off-grip; throw must not abort setup.
		try {
			e.currentTarget.setPointerCapture?.( e.pointerId );
		} catch {
			// no-op — drag proceeds without capture.
		}
		const els = /** @type {HTMLElement[]} */ ( rowElements( rootRef ) );
		dragNameRef.current = name;
		dragStartYRef.current = e.clientY;
		dragElsRef.current = els;
		dragRectsRef.current = activeRowRects( rootRef );
		dragNamesRef.current = displayedRef.current;
		dragFromRef.current = els.findIndex(
			( el ) => el.getAttribute( 'data-topology-row' ) === name
		);
		// Passed-over rows animate their shift; dragged row tracks cursor 1:1.
		els.forEach( ( el, i ) => {
			el.style.transition =
				i === dragFromRef.current ? '' : 'transform 0.15s ease';
		} );
		setDragName( name );
	}, [] );
	const onGripPointerMove = useCallback( ( e ) => {
		if ( ! dragNameRef.current ) {
			return;
		}
		// One transform pass per frame; pointermove > refresh rate.
		dragYRef.current = e.clientY;
		if ( null !== dragRafRef.current ) {
			return;
		}
		dragRafRef.current = window.requestAnimationFrame( () => {
			dragRafRef.current = null;
			const els = dragElsRef.current;
			const from = dragFromRef.current;
			if ( from < 0 || ! els[ from ] ) {
				return;
			}
			const { transforms } = dragGapTransforms(
				dragRectsRef.current,
				from,
				dragYRef.current - dragStartYRef.current,
				dragYRef.current
			);
			els.forEach( ( el, i ) => {
				el.style.transform = `translateY(${ transforms[ i ] }px)`;
			} );
			const dragged = els[ from ];
			dragged.style.zIndex = '10';
			dragged.style.position = 'relative';
		} );
	}, [] );
	const onGripPointerUp = useCallback( () => {
		if ( ! dragNameRef.current ) {
			return;
		}
		const name = dragNameRef.current;
		dragNameRef.current = null;
		if ( null !== dragRafRef.current ) {
			window.cancelAnimationFrame( dragRafRef.current );
			dragRafRef.current = null;
		}
		// Reset rows' inline drag styling; React re-renders in new order.
		dragElsRef.current.forEach( ( el ) => {
			el.style.transform = '';
			el.style.transition = '';
			el.style.zIndex = '';
			el.style.position = '';
		} );
		dragElsRef.current = [];
		// Commit ONCE: cursor-end vs cached geometry, over the persisted order.
		const reordered = dragReorder(
			dragNamesRef.current,
			name,
			dragRectsRef.current,
			dragYRef.current
		);
		setOrder( ( prev ) => mergeStoredOrder( prev, reordered ) );
		setDragName( null );
	}, [] );

	const writes = editing
		? { activate: nothing, deactivate: nothing, restart: nothing }
		: { activate, deactivate, restart };

	return (
		<div className="nodes-overview" ref={ rootRef }>
			{ actives.length > 0 && (
				<div className="nodes-overview__toolbar">
					<button
						type="button"
						className="nodes-overview__foldall button button-small"
						onClick={ foldAll }
					>
						{ __( 'Fold all', 'newspack-nodes' ) }
					</button>
					<button
						type="button"
						className="nodes-overview__unfoldall button button-small"
						onClick={ unfoldAll }
					>
						{ __( 'Unfold all', 'newspack-nodes' ) }
					</button>
				</div>
			) }
			<div className="nodes-overview__rows">
				{ orderedActives.map( ( t ) => (
					<TopologyRow
						key={ t.name }
						topology={ t }
						folded={ ! expanded.has( t.name ) }
						onActivate={ writes.activate }
						onDeactivate={ writes.deactivate }
						onRestart={ writes.restart }
						onExpand={ expandTopology }
						onCollapseTopology={ collapseTopology }
						isDragging={ dragName === t.name }
						onGripPointerDown={ onGripPointerDown }
						onGripPointerMove={ onGripPointerMove }
						onGripPointerUp={ onGripPointerUp }
						collapsed={ collapsed }
						onToggleFold={ onToggleFold }
					/>
				) ) }
			</div>
			{ stopped.length > 0 && (
				<div className="nodes-overview__stopped">
					<span className="nodes-overview__stopped-label">
						{ __( 'Stopped', 'newspack-nodes' ) }
					</span>
					{ stopped.map( ( t ) => (
						<span
							key={ t.name }
							className="newspack-nodes-badge nodes-overview__stopped-item"
						>
							<span className="nodes-overview__name">
								{ t.name }
							</span>
							<TopologyControls
								name={ t.name }
								active={ false }
								onActivate={ writes.activate }
								onDeactivate={ writes.deactivate }
								onRestart={ writes.restart }
								editHref={ consoleHref( t.name, {
									edit: true,
								} ) }
							/>
						</span>
					) ) }
				</div>
			) }
			{ alert && (
				<AlertModal
					title={
						alert.warning
							? sprintf(
									// translators: %s: topology name.
									__(
										'Activated “%s”, with a warning',
										'newspack-nodes'
									),
									alert.name
							  )
							: sprintf(
									// translators: %s: topology name.
									__(
										'Couldn’t update “%s”',
										'newspack-nodes'
									),
									alert.name
							  )
					}
					message={ alert.message }
					onClose={ () => setAlert( null ) }
				/>
			) }
		</div>
	);
}

export default { View };

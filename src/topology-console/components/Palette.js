/**
 * Edit-mode palette of node classes. Dragging an item to the canvas uses
 * pointer events (Firefox-safe; native HTML5 DnD never initiates there): a
 * pointer-down arms a ghost that follows the cursor, and pointer-up over the
 * canvas SVG projects the cursor into SVG space and calls onDropNode.
 */

import { useRef, useState } from '@wordpress/element';

// Categories that stay in the catalog (so the inspector still resolves their
// command/request buttons via catalog.find) but are NOT draggable in the palette.
// Service CIs are mounted into the request graph, never make_node'd, so dragging
// one would only mint a stray duplicate.
const NON_DRAGGABLE_CATEGORIES = new Set( [ 'Service' ] );

function groupByCategory( classes ) {
	const out = {};
	for ( const c of classes ) {
		( out[ c.category ] ||= [] ).push( c );
	}
	for ( const cat of Object.keys( out ) ) {
		out[ cat ].sort( ( a, b ) =>
			a.shell_name.localeCompare( b.shell_name )
		);
	}
	return out;
}

export default function Palette( {
	classes = [],
	loading = false,
	collapsed = false,
	onToggle,
	onDropNode,
} ) {
	// Drag ghost following the cursor ({ shellName, x, y } | null). dragRef holds
	// the in-flight shellName so the pointer handlers stay stable across renders.
	const [ ghost, setGhost ] = useState( null );
	const dragRef = useRef( null );

	const onItemPointerDown = ( e, shellName ) => {
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture( e.pointerId );
		} catch {
			// jsdom / browsers without pointer capture — drag still works.
		}
		dragRef.current = shellName;
		setGhost( { shellName, x: e.clientX, y: e.clientY } );
	};

	const onItemPointerMove = ( e ) => {
		if ( ! dragRef.current ) {
			return;
		}
		setGhost( {
			shellName: dragRef.current,
			x: e.clientX,
			y: e.clientY,
		} );
	};

	const onItemPointerUp = ( e ) => {
		const shellName = dragRef.current;
		dragRef.current = null;
		setGhost( null );
		if ( shellName ) {
			dropAt( shellName, e.clientX, e.clientY );
		}
	};

	const onItemPointerCancel = () => {
		dragRef.current = null;
		setGhost( null );
	};

	// Project the cursor onto the canvas SVG beneath it (the ghost is
	// pointer-events:none so elementFromPoint sees the SVG, not the ghost).
	const dropAt = ( shellName, clientX, clientY ) => {
		const target = document.elementFromPoint( clientX, clientY );
		const svg =
			target &&
			target.closest &&
			target.closest( 'svg.topology-canvas-svg' );
		if ( ! svg || ! svg.createSVGPoint || ! onDropNode ) {
			return;
		}
		const pt = svg.createSVGPoint();
		pt.x = clientX;
		pt.y = clientY;
		const ctm = svg.getScreenCTM();
		if ( ! ctm ) {
			return;
		}
		const local = pt.matrixTransform( ctm.inverse() );
		onDropNode( { shellName, x: local.x, y: local.y } );
	};
	// Collapsed view: a slim vertical rail with just the expand button,
	// so the user can always bring the palette back without reloading.
	if ( collapsed ) {
		return (
			<aside className="topology-palette topology-palette--collapsed">
				{ onToggle && (
					<button
						type="button"
						className="topology-palette__toggle topology-palette__toggle--collapsed"
						onClick={ onToggle }
						aria-label="Expand palette"
						title="Expand palette"
					>
						{ '›' }
					</button>
				) }
			</aside>
		);
	}
	if ( loading && ! classes.length ) {
		return (
			<aside className="topology-palette">
				{ onToggle && (
					<button
						type="button"
						className="topology-palette__toggle"
						onClick={ onToggle }
						aria-label="Collapse palette"
						title="Collapse palette"
					>
						{ '‹' }
					</button>
				) }
				<div className="topology-palette__footer">Loading…</div>
			</aside>
		);
	}
	const draggable = classes.filter(
		( c ) => ! NON_DRAGGABLE_CATEGORIES.has( c.category )
	);
	const grouped = groupByCategory( draggable );
	const total = draggable.length;

	return (
		<aside className="topology-palette">
			{ onToggle && (
				<button
					type="button"
					className="topology-palette__toggle"
					onClick={ onToggle }
					aria-label="Collapse palette"
					title="Collapse palette"
				>
					{ '‹' }
				</button>
			) }
			{ Object.entries( grouped ).map( ( [ group, items ] ) => (
				<div key={ group }>
					<h3 className="topology-palette__group">{ group }</h3>
					{ items.map( ( c ) => (
						<div
							key={ c.shell_name }
							className={ `topology-palette__item topology-palette__item--${ c.shell_name.toLowerCase() }` }
							data-shell-name={ c.shell_name }
							title={ c.description || '' }
							onPointerDown={ ( e ) =>
								onItemPointerDown( e, c.shell_name )
							}
							onPointerMove={ onItemPointerMove }
							onPointerUp={ onItemPointerUp }
							onPointerCancel={ onItemPointerCancel }
						>
							<div className="topology-palette__glyph" />
							<div className="topology-palette__name">
								{ c.shell_name }
							</div>
						</div>
					) ) }
				</div>
			) ) }
			<div className="topology-palette__footer">
				<span className="topology-palette__count">{ total }</span>{ ' ' }
				classes registered
			</div>
			{ ghost && (
				<div
					className="topology-palette__drag-ghost"
					style={ { left: ghost.x, top: ghost.y } }
				>
					{ ghost.shellName }
				</div>
			) }
		</aside>
	);
}

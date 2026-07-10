/**
 * Edit-mode palette of node classes. Dragging an item to the canvas uses
 * pointer events (Firefox-safe; native HTML5 DnD never initiates there): a
 * pointer-down arms a ghost that follows the cursor, and pointer-up over the
 * canvas SVG projects the cursor into SVG space and calls onDropNode.
 */

import { useRef, useState } from '@wordpress/element';
import { NODE_W, NODE_H, PORT_R } from './SchematicCanvas';

// Categories kept in the catalog but NOT draggable (Service CIs are mounted).
const NON_DRAGGABLE_CATEGORIES = new Set( [ 'Service', 'Remote' ] );

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
	// Drag ghost following the cursor (or null); dragRef keeps handlers stable.
	const [ ghost, setGhost ] = useState( null );
	const dragRef = useRef( null );

	// accepts_fill/has_target default true; glyph marks only an ABSENT port.
	const acceptsFillOf = ( c ) => c.accepts_fill !== false;
	const hasTargetOf = ( c ) => c.has_target !== false;
	const glyphClass = ( acceptsFill, hasTarget ) =>
		`topology-palette__glyph${
			acceptsFill ? '' : ' topology-palette__glyph--no-in'
		}${ hasTarget ? '' : ' topology-palette__glyph--no-out' }`;

	const onItemPointerDown = ( e, c ) => {
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture( e.pointerId );
		} catch {
			// jsdom / browsers without pointer capture — drag still works.
		}
		dragRef.current = c.shell_name;
		setGhost( {
			shellName: c.shell_name,
			acceptsFill: acceptsFillOf( c ),
			hasTarget: hasTargetOf( c ),
			x: e.clientX,
			y: e.clientY,
		} );
	};

	const onItemPointerMove = ( e ) => {
		setGhost( ( prev ) =>
			prev ? { ...prev, x: e.clientX, y: e.clientY } : prev
		);
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

	// Project cursor onto the canvas SVG (ghost is pointer-events:none).
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
	// Collapsed: a slim rail with just the expand button (no reload needed).
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
							onPointerDown={ ( e ) => onItemPointerDown( e, c ) }
							onPointerMove={ onItemPointerMove }
							onPointerUp={ onItemPointerUp }
							onPointerCancel={ onItemPointerCancel }
						>
							<div
								className={ glyphClass(
									acceptsFillOf( c ),
									hasTargetOf( c )
								) }
							/>
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
				// Ghost = the dropped node card; pointer-events:none for hit-testing.
				<svg
					className="topology-palette__drag-ghost"
					style={ { left: ghost.x, top: ghost.y } }
					width={ NODE_W + 2 * PORT_R }
					height={ NODE_H + 6 }
					viewBox={ `${ -PORT_R } 0 ${ NODE_W + 2 * PORT_R } ${
						NODE_H + 6
					}` }
				>
					<g className="topology-node">
						<rect
							className="topology-node__shadow"
							x={ 3 }
							y={ 3 }
							width={ NODE_W }
							height={ NODE_H }
						/>
						<rect
							className="topology-node__bg"
							width={ NODE_W }
							height={ NODE_H }
						/>
						<rect
							className="topology-node__header"
							width={ NODE_W }
							height={ 22 }
						/>
						<line
							className="topology-node__divider"
							x1={ 0 }
							y1={ 22 }
							x2={ NODE_W }
							y2={ 22 }
						/>
						<text className="topology-node__type" x={ 11 } y={ 15 }>
							{ ghost.shellName }
						</text>
						<circle
							className="topology-node__led"
							cx={ NODE_W - 12 }
							cy={ 13 }
							r={ 3.5 }
						/>
						{ ghost.acceptsFill && (
							<circle
								className="topology-port topology-port--in"
								cx={ 0 }
								cy={ NODE_H / 2 }
								r={ PORT_R }
							/>
						) }
						{ ghost.hasTarget && (
							<circle
								className="topology-port topology-port--out"
								cx={ NODE_W }
								cy={ NODE_H / 2 }
								r={ PORT_R }
							/>
						) }
					</g>
				</svg>
			) }
		</aside>
	);
}

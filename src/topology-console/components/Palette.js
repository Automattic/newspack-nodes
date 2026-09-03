/**
 * The palette dock: the source end of every add-a-node gesture on the
 * schematic canvas, mounted by the topology console and by the debug overlay's
 * inspector tab.
 *
 * The drag runs on pointer events rather than native HTML5 drag-and-drop,
 * which never initiates from these tiles in Firefox. A pointer-down arms a
 * ghost that follows the cursor, and a pointer-up over the canvas SVG projects
 * the cursor into SVG space and hands the consumer that point, so a dropped
 * node lands where the operator let go.
 */

import { useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { NODE_W, NODE_H, PORT_R } from './SchematicCanvas';
import { useCatalog } from '../CatalogContext';
import { useChrome } from '../ChromeContext';

/**
 * Categories the catalog carries that the palette must never offer.
 *
 * A Service CI is mounted on `newspack_nodes/request_graph_ready`, never
 * declared in TSL, so a tile for one would drop a node no topology can build.
 * Those entries still belong in the catalog, because the inspector reads the
 * same list for a selected node's verbs and arguments — which is why the
 * refusal sits here rather than in the `classes list` verb.
 */
const NON_DRAGGABLE_CATEGORIES = new Set( [ 'Service', 'Remote' ] );

/**
 * Buckets the class list into one group per category.
 *
 * Categories come out in the order they first appear, which the catalog's
 * `[category, shell_name]` sort makes alphabetical; each bucket is sorted by
 * shell name, so a tile's position never depends on the order the entries
 * arrived in.
 *
 * @param {ReadonlyArray<Object>} classes Class-catalog entries, each carrying `category` and `shell_name`.
 * @return {Object} Class entries keyed by category, sorted within each group.
 */
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

/**
 * Every topology `name` includes, directly or through another include.
 *
 * The palette asks this to refuse a drag that would form a cycle, so it walks
 * the whole `topologies list` DAG rather than the filtered tiles. `seen`
 * doubles as the visited set: an include chain that loops back terminates
 * instead of recursing forever.
 *
 * @param {string}                           name   Topology whose closure to compute.
 * @param {Map<string,{includes: string[]}>} byName Topology name to its list entry.
 * @param {Set<string>}                      [seen] Accumulator the recursion threads through.
 * @return {Set<string>} Every topology transitively included by `name`.
 */
function includeClosure( name, byName, seen = new Set() ) {
	for ( const child of byName.get( name )?.includes || [] ) {
		if ( seen.has( child ) ) {
			continue;
		}
		seen.add( child );
		includeClosure( child, byName, seen );
	}
	return seen;
}

/**
 * Renders the dock: a filter box over the node classes the catalog registers,
 * grouped by category, plus — in edit mode — the topologies that can be dragged
 * in as includes. Catalog data comes from CatalogContext and the collapse state
 * from ChromeContext; only the drop callbacks are the consumer's.
 *
 * @param {Object}   props                    Component props.
 * @param {boolean}  [props.loading]          Catalog fetch is in flight; the dock shows a placeholder until classes arrive. Default false.
 * @param {Function} [props.onDropNode]       ({ shellName, x, y }) — a class dropped on the canvas, x/y already projected into SVG space.
 * @param {boolean}  [props.editMode]         Render the draggable Topologies section. Default false.
 * @param {string}   [props.currentTopology]  The topology being edited; it and any topology whose include closure reaches it are undraggable, since either would form a cycle.
 * @param {string[]} [props.declaredIncludes] Topologies the draft already includes; their tiles are disabled.
 * @param {Function} [props.onDropTopology]   ({ name, x, y }) — a topology dropped on the canvas, to be included.
 * @return {import('react').ReactElement} The palette dock.
 */
export default function Palette( {
	loading = false,
	onDropNode,
	editMode = false,
	currentTopology = '',
	declaredIncludes = [],
	onDropTopology,
} ) {
	const { classes, topologies } = useCatalog();
	const { paletteCollapsed: collapsed, onPaletteToggle: onToggle } =
		useChrome();
	// Ghost is render state; the ref carries the in-flight drag identity.
	const [ ghost, setGhost ] = useState( null );
	const dragRef = useRef( null );
	// Case-insensitive filter over shell name + description; empty = full list.
	const [ query, setQuery ] = useState( '' );
	const searchRef = useRef( null );

	const clearQuery = () => {
		setQuery( '' );
		searchRef.current?.focus();
	};

	// accepts_fill/has_target default true; glyph marks only an ABSENT port.
	const acceptsFillOf = ( c ) => c.accepts_fill !== false;
	const hasTargetOf = ( c ) => c.has_target !== false;
	const fansOut = ( c ) => true === c.fans_out;
	const glyphClass = ( acceptsFill, hasTarget, fanOut ) =>
		`topology-palette__glyph${
			acceptsFill ? '' : ' topology-palette__glyph--no-in'
		}${ hasTarget ? '' : ' topology-palette__glyph--no-out' }${
			fanOut ? ' topology-palette__glyph--fanout' : ''
		}`;

	const onItemPointerDown = ( e, c ) => {
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture( e.pointerId );
		} catch {
			// jsdom / browsers without pointer capture — drag still works.
		}
		dragRef.current = { kind: 'node', name: c.shell_name };
		setGhost( {
			kind: 'node',
			shellName: c.shell_name,
			acceptsFill: acceptsFillOf( c ),
			hasTarget: hasTargetOf( c ),
			x: e.clientX,
			y: e.clientY,
		} );
	};

	const onTopologyPointerDown = ( e, t ) => {
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture( e.pointerId );
		} catch {
			// jsdom / browsers without pointer capture — drag still works.
		}
		dragRef.current = { kind: 'topology', name: t.name };
		setGhost( {
			kind: 'topology',
			name: t.name,
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
		const drag = dragRef.current;
		dragRef.current = null;
		setGhost( null );
		if ( drag ) {
			dropAt( drag, e.clientX, e.clientY );
		}
	};

	const onItemPointerCancel = () => {
		dragRef.current = null;
		setGhost( null );
	};

	// Project cursor onto the canvas SVG (ghost is pointer-events:none).
	const dropAt = ( { kind, name }, clientX, clientY ) => {
		const target = document.elementFromPoint( clientX, clientY );
		const svg = /** @type {SVGSVGElement} */ (
			target &&
				target.closest &&
				target.closest( 'svg.topology-canvas-svg' )
		);
		const onDrop = kind === 'topology' ? onDropTopology : onDropNode;
		if ( ! svg || ! svg.createSVGPoint || ! onDrop ) {
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
		if ( kind === 'topology' ) {
			onDrop( { name, x: local.x, y: local.y } );
		} else {
			onDrop( { shellName: name, x: local.x, y: local.y } );
		}
	};
	// One toggle box for both states; glyph + labels flip on `collapsed`.
	const toggleLabel = collapsed
		? __( 'Expand palette', 'newspack-nodes' )
		: __( 'Collapse palette', 'newspack-nodes' );
	const toggle = onToggle && (
		<button
			type="button"
			className="newspack-nodes-rail-toggle topology-palette__toggle"
			onClick={ onToggle }
			aria-label={ toggleLabel }
			aria-expanded={ ! collapsed }
			title={ toggleLabel }
		>
			{ collapsed ? '›' : '‹' }
		</button>
	);
	// Collapsed: dock is a slim rail with only the expand chevron, no aside.
	if ( collapsed ) {
		return (
			<div className="topology-palette-dock topology-palette-dock--collapsed">
				{ toggle }
			</div>
		);
	}
	if ( loading && ! classes.length ) {
		return (
			<div className="topology-palette-dock">
				{ toggle }
				<aside className="topology-palette">
					<div className="newspack-nodes-status topology-palette__footer">
						Loading…
					</div>
				</aside>
			</div>
		);
	}
	const draggable = classes.filter(
		( c ) => ! NON_DRAGGABLE_CATEGORIES.has( c.category )
	);
	// Footer count is the catalog total (registered), not the filtered view.
	const total = draggable.length;
	const q = query.trim().toLowerCase();
	const matches = q
		? draggable.filter(
				( c ) =>
					c.shell_name.toLowerCase().includes( q ) ||
					( c.description || '' ).toLowerCase().includes( q )
		  )
		: draggable;
	const grouped = groupByCategory( matches );
	// Filter the tiles too; byName keeps the full DAG for cycle detection.
	const shownTopologies = q
		? topologies.filter( ( t ) => t.name.toLowerCase().includes( q ) )
		: topologies;
	const byName = new Map( topologies.map( ( t ) => [ t.name, t ] ) );

	return (
		<div className="topology-palette-dock">
			{ toggle }
			<aside className="topology-palette">
				<div className="topology-palette__search-wrap">
					<input
						ref={ searchRef }
						type="search"
						className="topology-palette__search"
						value={ query }
						onChange={ ( e ) => setQuery( e.target.value ) }
						placeholder="Filter nodes…"
						aria-label="Filter node classes"
					/>
					{ query.length > 0 && (
						<button
							type="button"
							className="button is-plain topology-palette__search-clear"
							onClick={ clearQuery }
							aria-label="Clear filter"
							title="Clear filter"
						>
							×
						</button>
					) }
				</div>
				{ editMode && shownTopologies.length > 0 && (
					<div className="topology-palette__section">
						<h3 className="topology-palette__group">Topologies</h3>
						{ shownTopologies.map( ( t ) => {
							const disabled =
								t.name === currentTopology ||
								declaredIncludes.includes( t.name ) ||
								includeClosure( t.name, byName ).has(
									currentTopology
								);
							return (
								<div
									key={ t.name }
									data-testid={ `palette-topology-${ t.name }` }
									className={ `topology-palette__item topology-palette__item--topology${
										disabled ? ' is-disabled' : ''
									}` }
									title={
										disabled
											? 'Would form a cycle, or is already included'
											: `include ${ t.name }`
									}
									onPointerDown={ ( e ) =>
										disabled
											? undefined
											: onTopologyPointerDown( e, t )
									}
									onPointerMove={ onItemPointerMove }
									onPointerUp={ onItemPointerUp }
									onPointerCancel={ onItemPointerCancel }
								>
									<div className="topology-palette__hull-glyph" />
									<div className="topology-palette__name">
										{ t.name }
									</div>
								</div>
							);
						} ) }
					</div>
				) }
				{ Object.entries( grouped ).map( ( [ group, items ] ) => (
					<div key={ group } className="topology-palette__section">
						<h3 className="topology-palette__group">{ group }</h3>
						{ items.map( ( c ) => (
							<div
								key={ c.shell_name }
								className={ `topology-palette__item topology-palette__item--${ c.shell_name.toLowerCase() }` }
								data-shell-name={ c.shell_name }
								title={ c.description || '' }
								onPointerDown={ ( e ) =>
									onItemPointerDown( e, c )
								}
								onPointerMove={ onItemPointerMove }
								onPointerUp={ onItemPointerUp }
								onPointerCancel={ onItemPointerCancel }
							>
								<div
									className={ glyphClass(
										acceptsFillOf( c ),
										hasTargetOf( c ),
										fansOut( c )
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
				{ ghost && ghost.kind === 'topology' && (
					// Ghost = a rounded translucent hull blob, not a node card.
					<div
						className="topology-palette__drag-ghost topology-palette__drag-ghost--topology"
						style={ { left: ghost.x, top: ghost.y } }
					>
						{ ghost.name }
					</div>
				) }
				{ ghost && ghost.kind !== 'topology' && (
					// Ghost = dropped node card; pointer-events:none, no hits.
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
							<text
								className="topology-node__type"
								x={ 11 }
								y={ 15 }
							>
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
		</div>
	);
}

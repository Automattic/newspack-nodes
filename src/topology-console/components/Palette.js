/**
 * Edit-mode palette of node classes. Each item is HTML5-draggable and
 * carries its shell name on the dataTransfer payload for the canvas drop.
 */

const DRAG_MIME = 'application/x-newspack-node';

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
} ) {
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
							draggable
							title={ c.description || '' }
							onDragStart={ ( e ) => {
								e.dataTransfer.setData(
									DRAG_MIME,
									c.shell_name
								);
								e.dataTransfer.effectAllowed = 'copy';
							} }
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
		</aside>
	);
}

export { DRAG_MIME };

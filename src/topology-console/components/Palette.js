/**
 * Edit-mode palette of node classes. Each item is HTML5-draggable and
 * carries its shell name on the dataTransfer payload for the canvas drop.
 */

const DRAG_MIME = 'application/x-newspack-node';

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

export default function Palette( { classes = [], loading = false } ) {
	if ( loading && ! classes.length ) {
		return (
			<aside className="topology-palette">
				<div className="topology-palette__footer">Loading…</div>
			</aside>
		);
	}
	const grouped = groupByCategory( classes );
	const total = classes.length;

	return (
		<aside className="topology-palette">
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

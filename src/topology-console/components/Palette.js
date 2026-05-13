/**
 * Left-pane palette of available node classes.
 *
 * Inert in v1 — drag-to-create is a v2 affordance. The list itself is
 * static (mirrors the substrate's class registry); the count footer
 * tells the operator how many primitives are available.
 */

const PALETTE = {
	'I/O': [
		{ type: 'Tail', badge: 'SRC' },
		{ type: 'Consumer', badge: 'SRC' },
		{ type: 'Topic', badge: 'SNK' },
		{ type: 'Partition', badge: 'STO' },
	],
	Flow: [
		{ type: 'Tee' },
		{ type: 'Callback' },
		{ type: 'Hook' },
		{ type: 'Echo' },
	],
	Application: [
		{ type: 'RequestBuilder' },
		{ type: 'FlameBuilder' },
		{ type: 'JobRouter' },
		{ type: 'JobWorker' },
		{ type: 'StreamMerger' },
	],
	Control: [ { type: 'Timer' }, { type: 'Log' } ],
};

function totalClasses() {
	return Object.values( PALETTE ).reduce(
		( sum, group ) => sum + group.length,
		0
	);
}

export default function Palette() {
	return (
		<aside className="topology-palette">
			{ Object.entries( PALETTE ).map( ( [ group, items ] ) => (
				<div key={ group }>
					<h3 className="topology-palette__group">{ group }</h3>
					{ items.map( ( item ) => (
						<div
							key={ item.type }
							className={ `topology-palette__item topology-palette__item--${ item.type.toLowerCase() }` }
							data-type={ item.type }
						>
							<div className="topology-palette__glyph" />
							<div className="topology-palette__name">
								{ item.type }
							</div>
							{ item.badge && (
								<div className="topology-palette__badge">
									{ item.badge }
								</div>
							) }
						</div>
					) ) }
				</div>
			) ) }
			<div className="topology-palette__footer">
				<span className="topology-palette__count">
					{ totalClasses() }
				</span>{ ' ' }
				classes registered
			</div>
		</aside>
	);
}

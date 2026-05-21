/**
 * Decorative frame around the SVG canvas — engineering plotter chrome.
 */

const DRAWN_BY =
	( window.NewspackNodesData && window.NewspackNodesData.userLogin ) || '—';

function todayISO() {
	return new Date().toISOString().slice( 0, 10 );
}

export default function CanvasFrame( {
	topology,
	partition,
	children,
	onResetLayout,
	onSaveLayout,
	editMode,
} ) {
	return (
		<div className="topology-canvas">
			<div className="topology-canvas__meta">
				{ topology }
				{ partition !== null && partition !== undefined
					? ` · Partition ${ partition }`
					: '' }
				<div className="topology-canvas__topology-name">
					topologies/{ topology }.tsl
				</div>
			</div>

			<div className="topology-reticle topology-reticle--tl" />
			<div className="topology-reticle topology-reticle--tr" />
			<div className="topology-reticle topology-reticle--bl" />
			<div className="topology-reticle topology-reticle--br" />

			{ /* Layout controls — Save is edit-mode only; Reset shows in both. */ }
			<div className="topology-canvas__layout-actions">
				{ editMode && onSaveLayout && (
					<button
						type="button"
						className="topology-canvas__layout-chip"
						onClick={ onSaveLayout }
						title="Save current node positions as this topology's default layout"
					>
						💾 Save layout
					</button>
				) }
				{ onResetLayout && (
					<button
						type="button"
						className="topology-canvas__layout-chip"
						onClick={ onResetLayout }
						title="Revert to this topology's saved layout (or auto-layout if none)"
					>
						↺ Reset layout
					</button>
				) }
			</div>

			{ children }

			<div className="topology-title-block">
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">Project</div>
					<div className="topology-title-block__v topology-title-block__v--proj">
						EVENT LOG/NODES
					</div>
				</div>
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">Drawn</div>
					<div className="topology-title-block__v">
						{ DRAWN_BY } · { todayISO() }
					</div>
				</div>
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">Sheet</div>
					<div className="topology-title-block__v">
						{ topology }.p{ partition }
					</div>
				</div>
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">Scale</div>
					<div className="topology-title-block__v">
						1:1 · do not detail
					</div>
				</div>
			</div>
		</div>
	);
}

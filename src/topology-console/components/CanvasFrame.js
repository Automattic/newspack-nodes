/**
 * Decorative frame around the SVG canvas — engineering plotter chrome.
 */

import { __ } from '@wordpress/i18n';

const DRAWN_BY =
	( window.NewspackNodesData && window.NewspackNodesData.userLogin ) || '—';

function todayISO() {
	return new Date().toISOString().slice( 0, 10 );
}

export default function CanvasFrame( {
	topology,
	partition,
	isWorker,
	children,
	onResetLayout,
	onSaveLayout,
	editMode,
} ) {
	return (
		<div className="topology-canvas">
			<div className="topology-canvas__meta">
				{ topology }
				{ isWorker && partition !== null && partition !== undefined
					? ` · Partition ${ partition }`
					: '' }
				{ isWorker && (
					<div className="topology-canvas__topology-name">
						topologies/{ topology }.tsl
					</div>
				) }
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
						title={ __(
							"Save current node positions as this topology's default layout",
							'newspack-nodes'
						) }
					>
						💾 { __( 'Save layout', 'newspack-nodes' ) }
					</button>
				) }
				{ onResetLayout && (
					<button
						type="button"
						className="topology-canvas__layout-chip"
						onClick={ onResetLayout }
						title={ __(
							"Revert to this topology's saved layout (or auto-layout if none)",
							'newspack-nodes'
						) }
					>
						↺ { __( 'Reset layout', 'newspack-nodes' ) }
					</button>
				) }
			</div>

			{ children }

			<div className="topology-title-block">
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">
						{ __( 'Project', 'newspack-nodes' ) }
					</div>
					<div className="topology-title-block__v topology-title-block__v--proj">
						EVENT LOG/NODES
					</div>
				</div>
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">
						{ __( 'Drawn', 'newspack-nodes' ) }
					</div>
					<div className="topology-title-block__v">
						{ DRAWN_BY } · { todayISO() }
					</div>
				</div>
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">
						{ __( 'Sheet', 'newspack-nodes' ) }
					</div>
					<div className="topology-title-block__v">
						{ isWorker
							? `${ topology }.p${ partition }`
							: topology }
					</div>
				</div>
				<div className="topology-title-block__row">
					<div className="topology-title-block__k">
						{ __( 'Scale', 'newspack-nodes' ) }
					</div>
					<div className="topology-title-block__v">
						1:1 · { __( 'do not detail', 'newspack-nodes' ) }
					</div>
				</div>
			</div>
		</div>
	);
}

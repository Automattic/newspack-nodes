/**
 * Chrome for the graph canvas: the drafting-sheet framing plus the layout
 * action chips, shared by the topology console and the debug overlay's
 * Inspector tab.
 */

import { __ } from '@wordpress/i18n';

/**
 * The slice of the PHP-localized payload this file reads. Admin localizes many
 * more per-screen keys onto the same global.
 *
 * @typedef {Object} CanvasLocalizedData
 * @property {string} [userLogin] Login of the viewing user, stamped into the
 *                                title block's "Drawn" row. An enqueue site
 *                                supplies it among the `localize` extras it
 *                                hands `Admin::enqueue_react_page()`; a screen
 *                                that omits it renders the fallback instead.
 */

/**
 * `window` carrying the localize payload PHP writes before any bundle runs.
 *
 * @typedef {Window & {
 *     NewspackNodesData?: CanvasLocalizedData,
 * }} CanvasWindow
 */

/**
 * The login the title block's "Drawn" row shows, read once at module load:
 * PHP writes the payload before any bundle runs, and the viewing user cannot
 * change while the page lives. The em dash holds the row's shape when no login
 * was localized.
 */
const DRAWN_BY =
	/** @type {CanvasWindow} */ ( window ).NewspackNodesData?.userLogin || '—';

/**
 * Today's date, for the title block's "Drawn" row.
 *
 * `toISOString()` reports UTC rather than the viewer's zone, so a viewer far
 * enough from UTC reads the neighbouring day. Nothing keys off the value — the
 * row is drafting-sheet ornament.
 *
 * @return {string} The date as `YYYY-MM-DD`.
 */
function todayISO() {
	return new Date().toISOString().slice( 0, 10 );
}

/**
 * The plotter chrome drawn around the graph canvas: the scope meta line, four
 * corner reticles, the layout-action chips, and the drafting title block. It
 * holds no state of its own, and a chip renders only when its handler is
 * supplied, so a consumer hides one by passing null rather than by a separate
 * visibility flag.
 *
 * @param {Object}                    props
 * @param {string}                    props.topology        Topology being viewed, or the draft's name in edit mode; also the `.tsl` filename shown for a worker scope.
 * @param {number|null}               [props.partition]     Partition index of a worker scope; null or absent outside one.
 * @param {boolean}                   [props.isWorker]      The scope is a live worker, which adds the `· Partition N` suffix, the `topologies/<name>.tsl` line, and the `.p<N>` Sheet pad.
 * @param {import('react').ReactNode} [props.children]      The canvas the chrome wraps.
 * @param {(() => void)|null}         [props.onResetLayout] Revert to the topology's saved layout; null hides the chip.
 * @param {(() => void)|null}         [props.onSaveLayout]  Save the current node positions as the default layout; null (or view mode) hides the chip.
 * @param {(() => void)|null}         [props.onResetGraph]  Tear down and rebuild the browser console graph; null hides the chip.
 * @param {boolean}                   [props.editMode]      Edit mode, which is the only mode offering Save layout.
 * @return {import('react').ReactElement} The framed canvas.
 */
export default function CanvasFrame( {
	topology,
	partition,
	isWorker,
	children,
	onResetLayout,
	onSaveLayout,
	onResetGraph,
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
						className="button button-small topology-canvas__layout-chip"
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
						className="button button-small topology-canvas__layout-chip"
						onClick={ onResetLayout }
						title={ __(
							"Revert to this topology's saved layout (or auto-layout if none)",
							'newspack-nodes'
						) }
					>
						↺ { __( 'Reset layout', 'newspack-nodes' ) }
					</button>
				) }
				{ onResetGraph && (
					<button
						type="button"
						className="button button-small topology-canvas__layout-chip"
						onClick={ onResetGraph }
						title={ __(
							'Tear down + rebuild the browser console graph (recover from a self-inflicted edit) — does not reload the page',
							'newspack-nodes'
						) }
					>
						⟳ { __( 'Reset graph', 'newspack-nodes' ) }
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

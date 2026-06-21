/**
 * TopologyRow — one topology's UNFOLDED detail row, shared by the merged Overview
 * tab. The heading carries the name (live link when active) + per-partition pills
 * + source/health badges + a topology-level collapse chevron (folds the row back
 * to its compact summary) + the shared activate/restart/edit controls; the body
 * renders the live `TopologySection` subtree (or a "Stopped" row when inactive).
 *
 * The topology-level fold (`onCollapseTopology`, whole-row expand/collapse) and
 * the within-tree node fold (`collapsed`/`onToggleFold`, threaded straight into
 * TopologySection) are SEPARATE concerns — don't conflate them.
 */

import { memo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import TopologySection from './TopologySection';
import TopologyControls from './TopologyControls';
import { buildTopologySections } from './topologyGraph';
import { partitionSummaries } from './partitionSummaries';
import { formatAge, formatEtaSeconds } from './formatters';
import './TopologyRow.scss';

// Opens the DevTools hub's Console tab (the hub reads `?tab=` to pick it). A
// `name` scopes it via `?topology=`; `edit` adds `?edit=1` to open that topology
// in the editor; `isNew` adds `?new=1` to open a BLANK editor draft. `new` is a
// distinct signal (not `?edit=1` sans topology) because the console's
// topology→URL sync writes the default `?topology` on mount, which would
// otherwise make a New link look like an edit of the default topology.
export const consoleHref = ( name, { edit = false, isNew = false } = {} ) => {
	const params = new URLSearchParams( {
		page: 'newspack-nodes-hub',
		tab: 'console',
	} );
	if ( name ) {
		params.set( 'topology', name );
	}
	if ( edit ) {
		params.set( 'edit', '1' );
	}
	if ( isNew ) {
		params.set( 'new', '1' );
	}
	return `admin.php?${ params.toString() }`;
};

// Source → badge label. Mirrors the topology-resolution provenance: stock-only,
// user-only, or user-shadows-stock.
const SOURCE_LABELS = {
	stock: __( 'stock', 'newspack-nodes' ),
	user: __( 'user only', 'newspack-nodes' ),
	both: __( 'user ▸ shadows stock', 'newspack-nodes' ),
};

// Rolled-up topology health → heading label (dot + text via the scss).
const HEALTH_LABELS = {
	ok: __( 'ok', 'newspack-nodes' ),
	behind: __( 'behind', 'newspack-nodes' ),
	stalled: __( 'stalled', 'newspack-nodes' ),
};

// Build the single `TopologySection` model for one active topology's live status.
// `status` carries the topology's `.tsl` graphTopo + workers (plus the enriched
// rate/segment/time slices the body threads through); buildTopologySections keys
// on topology name, so wrap the graph in a one-entry map and take the section.
export function sectionFor( name, status ) {
	if ( ! status || ! status.graph ) {
		return null;
	}
	const sections = buildTopologySections(
		{ [ name ]: status.graph },
		status.workers || [],
		status.logs
	);
	return sections[ 0 ] || null;
}

/**
 * One topology's row — the SAME heading whether folded (compact summary) or
 * unfolded (heading + live detail tree); only the chevron (▸/▾) and the presence
 * of the body differ. So the folded summary and the expanded view share one set
 * of per-partition pills + badges, and each partition shows its OWN uptime.
 *
 * @param {Object}   props                      Component props.
 * @param {Object}   props.topology             Topology row from useTopologyManager.
 * @param {boolean}  [props.folded]             Render the heading only (▸ expand) vs heading + body (▾ collapse).
 * @param {Function} props.onActivate           (name) => Promise.
 * @param {Function} props.onDeactivate         (name) => Promise.
 * @param {Function} props.onRestart            (name) => Promise.
 * @param {Function} props.onError              ({name,message}) => void; a rejected mutation.
 * @param {Function} [props.onExpand]           (name) => void; unfold this row (folded chevron).
 * @param {Function} [props.onCollapseTopology] (name) => void; fold this row (unfolded chevron).
 * @param {Function} [props.onDragStart]        (name, event) => void; begin a row-reorder drag (adds a grip).
 * @param {Function} [props.onDropOn]           (name, event) => void; drop a dragged row before this one.
 * @param {Set}      [props.collapsed]          Within-tree node-fold set (unfolded only).
 * @param {Function} [props.onToggleFold]       (key) => void within-tree node-fold toggler.
 * @return {import('react').ReactElement} Rendered row.
 */
const TopologyRow = memo( function TopologyRow( {
	topology,
	folded = false,
	onActivate,
	onDeactivate,
	onRestart,
	onError,
	onExpand,
	onCollapseTopology,
	onDragStart,
	onDropOn,
	collapsed,
	onToggleFold,
} ) {
	const { name, source, active, health = 'ok', etaSeconds = 0 } = topology;
	const section =
		! folded && active ? sectionFor( name, topology.status ) : null;
	// Per-partition process summary (uptime + heartbeat + restart_pending) and
	// the rolled-up ALL RUN / ALL DEAD badge.
	const parts = active
		? partitionSummaries( topology.status?.workers || [] )
		: [];
	const currentTime = topology.status?.currentTime;
	const up = parts.filter( ( p ) => p.status === 'running' ).length;
	const allRunning = parts.length > 0 && up === parts.length;
	const allDead =
		parts.length > 0 && parts.every( ( p ) => p.status === 'dead' );
	// ETA to catch up — shown only when behind/stalled (sub-minute lag reads ok).
	const eta = 'ok' !== health ? formatEtaSeconds( etaSeconds ) : '';

	return (
		<div
			className="nodes-tm__topology"
			onDragOver={
				onDropOn
					? ( e ) => {
							// preventDefault AND a 'move' dropEffect are BOTH required
							// for the drop to fire (Firefox is strict about this).
							e.preventDefault();
							e.dataTransfer.dropEffect = 'move';
					  }
					: undefined
			}
			onDrop={ onDropOn ? ( e ) => onDropOn( name, e ) : undefined }
		>
			<div className="nodes-tm__heading">
				{ onDragStart && (
					<span
						className="nodes-tm__grip"
						draggable={ true }
						aria-label={ __( 'Drag to reorder', 'newspack-nodes' ) }
						title={ __( 'Drag to reorder', 'newspack-nodes' ) }
						onDragStart={ ( e ) => onDragStart( name, e ) }
					>
						⠿
					</span>
				) }
				<button
					type="button"
					className={
						folded ? 'nodes-tm__expand' : 'nodes-tm__collapse'
					}
					title={
						folded
							? __( 'Expand', 'newspack-nodes' )
							: __( 'Collapse', 'newspack-nodes' )
					}
					aria-expanded={ ! folded }
					onClick={ () =>
						folded ? onExpand( name ) : onCollapseTopology( name )
					}
				>
					{ folded ? '▸' : '▾' }
				</button>
				{ active ? (
					// draggable=false so the native link-drag doesn't hijack the
					// row-reorder drag (the classic Firefox handle-drag killer).
					<a
						className="nodes-tm__name"
						href={ consoleHref( name ) }
						draggable={ false }
					>
						{ name }
					</a>
				) : (
					// Stopped: nothing live to open — plain label, not a
					// live-mode link (Edit still deep-links into the console).
					<span className="nodes-tm__name">{ name }</span>
				) }
				{ parts.map( ( p ) => (
					<span key={ p.partition } className="topology-partition">
						<span
							className={ `worker-status-badge compact ${ p.status }` }
						>
							P{ p.partition }
						</span>
						<span className="supervisor-age">
							{ p.started_at && p.status === 'running'
								? formatAge( p.started_at, currentTime )
								: '' }
						</span>
						{ p.heartbeat_age !== null &&
							p.heartbeat_age !== undefined && (
								<span
									className={ `connector-heartbeat ${
										p.heartbeat_age > 30 ? 'stale' : ''
									}` }
								>
									{ p.heartbeat_age }s
								</span>
							) }
						{ p.restart_pending && (
							<span
								className="connector-restart-pending"
								title={ __(
									'Restart pending',
									'newspack-nodes'
								) }
							>
								⟳
							</span>
						) }
					</span>
				) ) }
				{ allRunning && (
					<span className="worker-status-badge running small">
						{ __( 'ALL RUN', 'newspack-nodes' ) }
					</span>
				) }
				{ allDead && (
					<span className="worker-status-badge dead small">
						{ __( 'ALL DEAD', 'newspack-nodes' ) }
					</span>
				) }
				{ parts.length > 0 && ! allRunning && ! allDead && (
					<span className="worker-status-badge small">
						{ sprintf(
							// translators: %1$d: running partitions; %2$d: total.
							__( '%1$d/%2$d up', 'newspack-nodes' ),
							up,
							parts.length
						) }
					</span>
				) }
				<span
					className={ `nodes-tm__badge nodes-tm__badge--${ source }` }
				>
					{ SOURCE_LABELS[ source ] ?? source }
				</span>
				{ active && (
					<span
						className={ `nodes-tm__health nodes-tm__health--${ health }` }
					>
						{ HEALTH_LABELS[ health ] ?? health }
					</span>
				) }
				{ active && (
					// A fixed (often empty) slot so the controls don't shift between
					// a caught-up row and a behind one; populated only when behind.
					<span
						className="nodes-tm__eta"
						title={ __(
							'Estimated time to catch up',
							'newspack-nodes'
						) }
					>
						{ eta
							? sprintf(
									// translators: %s: ETA duration, e.g. "10m".
									__( 'ETA %s', 'newspack-nodes' ),
									eta
							  )
							: '' }
					</span>
				) }
				<TopologyControls
					name={ name }
					active={ active }
					onActivate={ onActivate }
					onDeactivate={ onDeactivate }
					onRestart={ onRestart }
					onError={ onError }
					editHref={ consoleHref( name, { edit: true } ) }
				/>
			</div>
			{ ! folded && (
				<div className="nodes-tm__body">
					{ section ? (
						<TopologySection
							section={ section }
							workers={ section.workers }
							byteRates={ topology.status.byteRates }
							writeRates={ topology.status.writeRates }
							segmentSize={ topology.status.segmentSize }
							currentTime={ topology.status.currentTime }
							prevSegments={ topology.status.prevSegments }
							removingSegments={
								topology.status.removingSegments
							}
							collapsed={ collapsed }
							onToggle={ onToggleFold }
						/>
					) : (
						<p className="nodes-tm__stopped">
							{ __( 'Stopped', 'newspack-nodes' ) }
						</p>
					) }
				</div>
			) }
		</div>
	);
} );

export { TopologyRow };

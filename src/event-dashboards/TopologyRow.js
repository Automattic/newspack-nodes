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
import { __ } from '@wordpress/i18n';
import TopologySection from './TopologySection';
import TopologyControls from './TopologyControls';
import { buildTopologySections } from './topologyGraph';
import { partitionSummaries } from './partitionSummaries';
import { formatAge } from './formatters';
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
 * One topology's unfolded detail row.
 *
 * @param {Object}   props                    Component props.
 * @param {Object}   props.topology           Topology row from useTopologyManager.
 * @param {Function} props.onActivate         (name) => Promise.
 * @param {Function} props.onDeactivate       (name) => Promise.
 * @param {Function} props.onRestart          (name) => Promise.
 * @param {Function} props.onError            ({name,message}) => void; a rejected mutation.
 * @param {Function} props.onCollapseTopology (name) => void; fold this row to its compact summary.
 * @param {Set}      props.collapsed          Within-tree node-fold set.
 * @param {Function} props.onToggleFold       (key) => void within-tree node-fold toggler.
 * @return {import('react').ReactElement} Rendered row.
 */
const TopologyRow = memo( function TopologyRow( {
	topology,
	onActivate,
	onDeactivate,
	onRestart,
	onError,
	onCollapseTopology,
	collapsed,
	onToggleFold,
} ) {
	const { name, source, active, health = 'ok' } = topology;
	const section = active ? sectionFor( name, topology.status ) : null;
	// Per-partition process summary (uptime + heartbeat + restart_pending) and
	// the rolled-up ALL RUN / ALL DEAD badge.
	const parts = active
		? partitionSummaries( topology.status?.workers || [] )
		: [];
	const currentTime = topology.status?.currentTime;
	const allRunning =
		parts.length > 0 && parts.every( ( p ) => p.status === 'running' );
	const allDead =
		parts.length > 0 && parts.every( ( p ) => p.status === 'dead' );

	return (
		<div className="nodes-tm__topology">
			<div className="nodes-tm__heading">
				<button
					type="button"
					className="nodes-tm__collapse"
					title={ __( 'Collapse', 'newspack-nodes' ) }
					aria-expanded={ true }
					onClick={ () => onCollapseTopology( name ) }
				>
					▾
				</button>
				{ active ? (
					<a className="nodes-tm__name" href={ consoleHref( name ) }>
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
						removingSegments={ topology.status.removingSegments }
						collapsed={ collapsed }
						onToggle={ onToggleFold }
					/>
				) : (
					<p className="nodes-tm__stopped">
						{ __( 'Stopped', 'newspack-nodes' ) }
					</p>
				) }
			</div>
		</div>
	);
} );

export { TopologyRow };

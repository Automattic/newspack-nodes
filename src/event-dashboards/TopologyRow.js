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
import './styles/topology-row.scss';

// Opens the hub Console tab; name/edit/isNew add ?topology/?edit/?new params.
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

// Source → badge label (provenance: stock-only, user-only, user-shadows-stock).
const SOURCE_LABELS = {
	stock: __( 'stock', 'newspack-nodes' ),
	user: __( 'user only', 'newspack-nodes' ),
	both: __( 'user ▸ shadows stock', 'newspack-nodes' ),
};
const SOURCE_TONES = {
	stock: 'is-info',
	user: 'is-neutral',
	both: 'is-warning',
};

// Rolled-up topology health → heading label (dot + text via the scss).
const HEALTH_LABELS = {
	ok: __( 'ok', 'newspack-nodes' ),
	behind: __( 'behind', 'newspack-nodes' ),
	stalled: __( 'stalled', 'newspack-nodes' ),
};
const HEALTH_TONES = {
	ok: 'is-success',
	behind: 'is-warning',
	stalled: 'is-error',
};

/**
 * Build the `TopologySection` model for one active topology's live status.
 *
 * @param {string}  name   Topology name; keys the single-entry graph handed to `buildTopologySections`.
 * @param {?Object} status The topology's merged live status from `useTopologyManager` — `graph`, `workers`, `logs`.
 * @return {?Object} The section `{ topology, workers, tree }`, or null when the
 *   topology is inactive and carries no graph.
 */
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
 * The grip's pointer handlers. `GripDown` also carries the row name, since one
 * handler serves every row; the rest read the event alone.
 *
 * @typedef {import('react').PointerEvent<HTMLSpanElement>} GripEvent
 * @typedef {import('react').PointerEventHandler<HTMLSpanElement>} GripHandler
 * @typedef {( name: string, event: GripEvent ) => void} GripDownHandler
 */

/**
 * @typedef {Object} TopologyRowProps
 * @property {Object}          topology             Topology row from useTopologyManager.
 * @property {boolean}         [folded]             Render the heading only (▸ expand) vs heading + body (▾ collapse).
 * @property {Function}        onActivate           (name) => Promise.
 * @property {Function}        onDeactivate         (name) => Promise.
 * @property {Function}        onRestart            (name) => Promise.
 * @property {Function}        onError              ({name,message}) => void; a rejected mutation.
 * @property {Function}        [onExpand]           (name) => void; unfold this row (folded chevron).
 * @property {Function}        [onCollapseTopology] (name) => void; fold this row (unfolded chevron).
 * @property {boolean}         [isDragging]         True while this row is the one being pointer-dragged.
 * @property {GripDownHandler} [onGripPointerDown]  Begin a pointer-drag from the grip.
 * @property {GripHandler}     [onGripPointerMove]  Pointer moved mid-drag (live reorder).
 * @property {GripHandler}     [onGripPointerUp]    End the pointer-drag (commit); also the cancel handler.
 * @property {Set}             [collapsed]          Within-tree node-fold set (unfolded only).
 * @property {Function}        [onToggleFold]       (key) => void within-tree node-fold toggler.
 */

/**
 * One topology's row — the SAME heading whether folded (compact summary) or
 * unfolded (heading + live detail tree); only the chevron (▸/▾) and the presence
 * of the body differ. So the folded summary and the expanded view share one set
 * of per-partition pills + badges, and each partition shows its OWN uptime.
 *
 * The props live in the `TopologyRowProps` typedef above: `memo()` hides the
 * inner function from a docblock on this declaration, so the type rides here.
 *
 * @type {import('react').NamedExoticComponent<TopologyRowProps>}
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
	isDragging = false,
	onGripPointerDown,
	onGripPointerMove,
	onGripPointerUp,
	collapsed,
	onToggleFold,
} ) {
	const { name, source, active, health = 'ok', etaSeconds = 0 } = topology;
	const section =
		! folded && active ? sectionFor( name, topology.status ) : null;
	// Per-partition process summary + the rolled-up ALL RUN / ALL DEAD badge.
	const parts = active
		? partitionSummaries( topology.status?.workers || [] )
		: [];
	const currentTime = topology.status?.currentTime;
	const up = parts.filter( ( p ) => p.status === 'running' ).length;
	const allRunning = parts.length > 0 && up === parts.length;
	const allDead =
		parts.length > 0 && parts.every( ( p ) => p.status === 'dead' );
	// ETA to catch up — shown only when behind/stalled (sub-minute reads ok).
	const eta = 'ok' !== health ? formatEtaSeconds( etaSeconds ) : '';

	return (
		<div
			className={ `newspack-nodes-card nodes-tm__topology${
				isDragging ? ' is-dragging' : ''
			}` }
			data-topology-row={ name }
		>
			<div className="nodes-tm__heading">
				{ onGripPointerDown && (
					<span
						className="nodes-tm__grip"
						aria-label={ __( 'Drag to reorder', 'newspack-nodes' ) }
						title={ __( 'Drag to reorder', 'newspack-nodes' ) }
						onPointerDown={ ( e ) => onGripPointerDown( name, e ) }
						onPointerMove={ onGripPointerMove }
						onPointerUp={ onGripPointerUp }
						onPointerCancel={ onGripPointerUp }
					>
						⠿
					</span>
				) }
				<button
					type="button"
					className={
						folded
							? 'newspack-nodes-disclosure nodes-tm__expand'
							: 'newspack-nodes-disclosure nodes-tm__collapse'
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
					// draggable=false so link-drag doesn't hijack the reorder.
					<a
						className="nodes-tm__name"
						href={ consoleHref( name ) }
						draggable={ false }
					>
						{ name }
					</a>
				) : (
					// Stopped: plain label, not a live link (Edit deep-links).
					<span className="nodes-tm__name">{ name }</span>
				) }
				<span className="nodes-tm__parts">
					{ parts.map( ( p ) => (
						<span
							key={ p.partition }
							className="topology-partition"
						>
							<span
								className={ `newspack-nodes-status-badge worker-status-badge compact ${ p.status }` }
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
											p.stale ? 'stale' : ''
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
				</span>
				{ /* Fixed-width slot so health lines up across rows. */ }
				<span className="nodes-tm__liveness">
					{ allRunning && (
						<span className="newspack-nodes-status-badge worker-status-badge running small">
							{ __( 'ALL RUN', 'newspack-nodes' ) }
						</span>
					) }
					{ allDead && (
						<span className="newspack-nodes-status-badge worker-status-badge dead small">
							{ __( 'ALL DEAD', 'newspack-nodes' ) }
						</span>
					) }
					{ parts.length > 0 && ! allRunning && ! allDead && (
						<span className="newspack-nodes-status-badge worker-status-badge small">
							{ sprintf(
								// translators: %1$d: running partitions; %2$d: total.
								__( '%1$d/%2$d up', 'newspack-nodes' ),
								up,
								parts.length
							) }
						</span>
					) }
				</span>
				{ /* Health sits after the liveness badge; ETA next to it. */ }
				{ active && (
					<span
						className={ `newspack-nodes-status newspack-nodes-status-indicator ${ HEALTH_TONES[ health ] } nodes-tm__health nodes-tm__health--${ health }` }
					>
						{ HEALTH_LABELS[ health ] ?? health }
					</span>
				) }
				{ active && (
					// Fixed slot so the provenance pill doesn't shift.
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
				{ /* Provenance pill pushed to the right, by the controls. */ }
				<span className="nodes-tm__badge-cell">
					<span
						className={ `newspack-nodes-status-badge is-pill ${ SOURCE_TONES[ source ] } nodes-tm__badge nodes-tm__badge--${ source }` }
					>
						{ SOURCE_LABELS[ source ] ?? source }
					</span>
				</span>
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

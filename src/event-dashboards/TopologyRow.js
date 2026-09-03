/**
 * TopologyRow — one topology's row on the hub's Overview board, folded or not.
 *
 * The heading is the same in both states: the reorder grip, the fold chevron,
 * the name (a live Console link while the topology runs), one pill per
 * partition, the liveness and health badges, the catch-up ETA, the provenance
 * badge, and the shared activate/restart/edit controls. Unfolding adds the
 * body: the live `TopologySection` subtree, or a "Stopped" line for an inactive
 * topology. One heading serving both states is what keeps the compact summary
 * and the expanded row from disagreeing about the same fleet.
 *
 * Two folds meet here and stay apart. The TOPOLOGY fold (`folded`, `onExpand`,
 * `onCollapseTopology`) shows or hides this row's whole body; the within-tree
 * NODE fold (`collapsed`, `onToggleFold`) is threaded straight through to
 * `TopologySection` and never read here.
 *
 * `consoleHref` lives here as well, so this row and its embedder build every
 * Console deep-link through one function rather than two spellings of the same
 * query string.
 */

import { memo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import TopologySection from './TopologySection';
import TopologyControls from './TopologyControls';
import { buildTopologySections } from './topologyGraph';
import { partitionSummaries } from './partitionSummaries';
import {
	formatAge,
	formatEtaSeconds,
} from '@newspack-nodes/shared/utils/formatters';
import './styles/topology-row.scss';

/**
 * Build a deep-link into the hub's Console tab.
 *
 * @param {string}  name            Topology to open; omit it for a blank draft.
 * @param {Object}  [options]       Which Console mode the link opens.
 * @param {boolean} [options.edit]  Open this topology in the TSL editor.
 * @param {boolean} [options.isNew] Open the editor on a new, unnamed topology.
 * @return {string} A wp-admin-relative `admin.php?…` href.
 */
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

/**
 * Provenance badge text per source: a topology a plugin ships, one the operator
 * wrote, or an operator file shadowing a stock topology of the same name.
 *
 * @type {Object<string,string>}
 */
const SOURCE_LABELS = {
	stock: __( 'stock', 'newspack-nodes' ),
	user: __( 'user only', 'newspack-nodes' ),
	both: __( 'user ▸ shadows stock', 'newspack-nodes' ),
};

/**
 * Badge tone per source. Shadowing is the warning tone because the topology
 * running is then not the one the plugin ships.
 *
 * @type {Object<string,string>}
 */
const SOURCE_TONES = {
	stock: 'is-info',
	user: 'is-neutral',
	both: 'is-warning',
};

/**
 * Heading label per rolled-up health state, which `useTopologyManager` derives:
 * `stalled` when the server marked a worker's heartbeat stale, `behind` when a
 * consumer needs a minute or more to catch up, else `ok`. The scss draws the
 * dot; this is the text beside it.
 *
 * @type {Object<string,string>}
 */
const HEALTH_LABELS = {
	ok: __( 'ok', 'newspack-nodes' ),
	behind: __( 'behind', 'newspack-nodes' ),
	stalled: __( 'stalled', 'newspack-nodes' ),
};

/**
 * Badge tone per health state.
 *
 * @type {Object<string,string>}
 */
const HEALTH_TONES = {
	ok: 'is-success',
	behind: 'is-warning',
	stalled: 'is-error',
};

/**
 * Build the `TopologySection` model for one active topology's live status.
 *
 * Wrapping the one graph in a single-entry map reuses the builder the whole
 * fleet's tree already goes through, so a subtree cannot render differently
 * here than it does there.
 *
 * @param {string}  name   Topology name; keys the single-entry graph handed to `buildTopologySections`.
 * @param {?Object} status The topology's merged live status from `useTopologyManager` — `graph`, `workers`, `logs`.
 * @return {?Object} The section `{ topology, workers, tree }`, or null when
 *   there is no live graph, which is what an inactive topology has.
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
 * @property {Object}                topology             One `useTopologyManager` row: `name`, `source`, `active`, `health`, `etaSeconds`, `num_partitions`, and the merged live `status`.
 * @property {boolean}               [folded]             Render the heading only (▸ expand) vs heading + body (▾ collapse).
 * @property {Function}              onActivate           (name) => void; fire-and-forget, since a refusal comes back through the hook's `onError` a tick later rather than as a rejected promise.
 * @property {Function}              onDeactivate         (name) => void.
 * @property {Function}              onRestart            (name) => void; restarts this topology's whole fleet.
 * @property {Function}              [onExpand]           (name) => void; unfold this row (folded chevron).
 * @property {Function}              [onCollapseTopology] (name) => void; fold this row (unfolded chevron).
 * @property {boolean}               [isDragging]         True while this row is the one being pointer-dragged.
 * @property {GripDownHandler}       [onGripPointerDown]  Begin a pointer-drag from the grip; omitting it renders no grip.
 * @property {GripHandler}           [onGripPointerMove]  Pointer moved mid-drag (live reorder).
 * @property {GripHandler}           [onGripPointerUp]    End the pointer-drag (commit); also the cancel handler.
 * @property {Set}                   [collapsed]          Within-tree node-fold set (unfolded only).
 * @property {(key: string) => void} [onToggleFold]       Within-tree node-fold toggler.
 */

/**
 * One topology's row: the heading always, the body only when unfolded.
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
	onExpand,
	onCollapseTopology,
	isDragging = false,
	onGripPointerDown,
	onGripPointerMove,
	onGripPointerUp,
	collapsed,
	onToggleFold,
} ) {
	const {
		name,
		source,
		active,
		health = 'ok',
		etaSeconds = 0,
		num_partitions: numPartitions,
	} = topology;
	const section =
		! folded && active ? sectionFor( name, topology.status ) : null;
	// One summary per partition; the badges below roll them up.
	const parts = active
		? partitionSummaries( topology.status?.workers || [] )
		: [];
	const currentTime = topology.status?.currentTime;
	const up = parts.filter( ( p ) => p.status === 'running' ).length;
	// @longform Count against the CONFIGURED partitions. A worker process that
	// is gone entirely reports no row at all — it is absent, not `dead` — so
	// the reporting count as the denominator reads "ALL RUN" on a 4-partition
	// topology running 2 workers. Fall back to it only when the row carries no
	// configured count.
	const expected = numPartitions > 0 ? numPartitions : parts.length;
	const allRunning = expected > 0 && up === expected;
	const allDead =
		parts.length > 0 && parts.every( ( p ) => p.status === 'dead' );
	// Nothing to do is the feature working, not the crash ALL DEAD implies.
	const allIdle = allDead && parts.every( ( p ) => p.idle );
	// Catch-up ETA, shown only while behind or stalled; under a minute is ok.
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
					// An inactive topology has no live Console to link to.
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
							<span className="process-age">
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
					{ allIdle && (
						<span className="newspack-nodes-status-badge worker-status-badge small">
							{ __( 'IDLE', 'newspack-nodes' ) }
						</span>
					) }
					{ allDead && ! allIdle && (
						<span className="newspack-nodes-status-badge worker-status-badge dead small">
							{ __( 'ALL DEAD', 'newspack-nodes' ) }
						</span>
					) }
					{ expected > 0 && ! allRunning && ! allDead && (
						<span className="newspack-nodes-status-badge worker-status-badge small">
							{ sprintf(
								// translators: %1$d: running partitions; %2$d: total.
								__( '%1$d/%2$d up', 'newspack-nodes' ),
								up,
								expected
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
					editHref={ consoleHref( name, { edit: true } ) }
				/>
			</div>
			{ ! folded && (
				<div className="nodes-tm__body">
					{ section ? (
						<TopologySection
							section={ section }
							workers={ section.workers }
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

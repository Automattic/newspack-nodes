/**
 * Topology Manager — the `host: 'hub'` DevTools tab. A thin view over
 * `useTopologyManager` that lists EVERY topology (active + inactive) with its
 * provenance badge + an active toggle (immediate activate/deactivate) + a fleet
 * restart, reusing the live worker-status tree for the active ones.
 *
 * This EXTENDS the shipped grouped worker-status tree: an active topology's
 * heading carries the controls (badge / toggle / restart) and its body renders
 * the same `TopologySection` subtree WorkerStatus.js uses, built from the
 * topology's live status section. An inactive topology shows only its heading +
 * a "Stopped" row. Fold state for the live subtrees is owned here, mirroring
 * WorkerStatus.js.
 */

import { memo, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import TopologySection from './TopologySection';
import AlertModal from './AlertModal';
import { SupervisorStatus } from './SupervisorStatus';
import { buildTopologySections } from './topologyGraph';
import { partitionSummaries } from './partitionSummaries';
import { formatAge } from './formatters';
import { useTopologyManager } from './hooks/useTopologyManager';
import './TopologyManager.scss';

// Opens the DevTools hub's Console tab scoped to that topology (the console
// reads `?topology=`; the hub reads `?tab=` to pick the Console tab).
const consoleHref = ( name ) =>
	`admin.php?page=newspack-nodes-hub&tab=console&topology=${ encodeURIComponent(
		name
	) }`;

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
function sectionFor( name, status ) {
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
 * One topology's row: heading (name + partitions + source badge + active toggle
 * + restart) and body (live TopologySection when active, else a Stopped row).
 *
 * @param {Object}   props              Component props.
 * @param {Object}   props.topology     Topology row from useTopologyManager.
 * @param {Function} props.onActivate   (name) => Promise.
 * @param {Function} props.onDeactivate (name) => Promise.
 * @param {Function} props.onRestart    (name) => Promise.
 * @param {Function} props.onError      ({name,message}) => void; a rejected mutation.
 * @param {Set}      props.collapsed    Fold-state set for the live subtree.
 * @param {Function} props.onToggleFold (key) => void fold toggler.
 * @return {import('react').ReactElement} Rendered row.
 */
const TopologyRow = memo( function TopologyRow( {
	topology,
	onActivate,
	onDeactivate,
	onRestart,
	onError,
	collapsed,
	onToggleFold,
} ) {
	const { name, source, active, health = 'ok' } = topology;
	// A rejected mutation must never crash the render — but instead of swallowing
	// it, surface the reason (e.g. an activate that write-conflicts) via onError
	// so the parent can show it in a modal.
	const fire = ( fn ) => () =>
		Promise.resolve( fn( name ) ).catch( ( err ) =>
			onError( { name, message: err?.message || String( err ) } )
		);
	const section = active ? sectionFor( name, topology.status ) : null;
	// Per-partition process summary (uptime + heartbeat + restart_pending) and
	// the rolled-up ALL RUN / ALL DEAD badge — moved up from the old section
	// header so the manager card heading is the single head.
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
				<a className="nodes-tm__name" href={ consoleHref( name ) }>
					{ name }
				</a>
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
				<button
					type="button"
					role="switch"
					aria-checked={ active }
					className={ `nodes-tm__toggle${ active ? ' is-on' : '' }` }
					title={
						active
							? __( 'Deactivate', 'newspack-nodes' )
							: __( 'Activate', 'newspack-nodes' )
					}
					onClick={ fire( active ? onDeactivate : onActivate ) }
				/>
				{ active && (
					<button
						type="button"
						className="nodes-tm__restart"
						title={ __( 'Restart fleet', 'newspack-nodes' ) }
						onClick={ fire( onRestart ) }
					>
						↻
					</button>
				) }
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

/**
 * Topology Manager hub tab.
 *
 * @return {import('react').ReactElement} Rendered component.
 */
export default function TopologyManager() {
	const {
		topologies,
		supervisor,
		currentTime,
		activate,
		deactivate,
		restart,
		connected,
	} = useTopologyManager();
	const [ collapsed, setCollapsed ] = useState( () => new Set() );
	// A rejected mutation ({ name, message }) raises this alert; null = hidden.
	const [ alert, setAlert ] = useState( null );
	const onToggleFold = ( key ) =>
		setCollapsed( ( prev ) => {
			const next = new Set( prev );
			if ( next.has( key ) ) {
				next.delete( key );
			} else {
				next.add( key );
			}
			return next;
		} );

	// Active topologies float to the top (they carry the live tree worth
	// watching); alphabetical within each group. Normalize `active` to a real
	// boolean so the group split stays a valid total order even if a row ever
	// arrives with active undefined/absent.
	const sorted = [ ...topologies ].sort( ( a, b ) => {
		const aActive = !! a.active;
		const bActive = !! b.active;
		if ( aActive !== bActive ) {
			return aActive ? -1 : 1;
		}
		return a.name.localeCompare( b.name );
	} );

	return (
		<div className="nodes-tm">
			<ConnectionBanner
				connectionError={ ! connected }
				message={ __( 'Disconnected — retrying…', 'newspack-nodes' ) }
			/>
			{ supervisor && (
				<SupervisorStatus
					supervisor={ supervisor }
					currentTime={ currentTime }
					onRestart={ () => restart( 'supervisor' ) }
				/>
			) }
			{ sorted.map( ( topology ) => (
				<TopologyRow
					key={ topology.name }
					topology={ topology }
					onActivate={ activate }
					onDeactivate={ deactivate }
					onRestart={ restart }
					onError={ setAlert }
					collapsed={ collapsed }
					onToggleFold={ onToggleFold }
				/>
			) ) }
			{ alert && (
				<AlertModal
					title={ sprintf(
						// translators: %s: topology name.
						__( 'Couldn’t update “%s”', 'newspack-nodes' ),
						alert.name
					) }
					message={ alert.message }
					onClose={ () => setAlert( null ) }
				/>
			) }
		</div>
	);
}

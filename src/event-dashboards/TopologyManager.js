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
import { SupervisorStatus } from './SupervisorStatus';
import { buildTopologySections } from './topologyGraph';
import { useTopologyManager } from './hooks/useTopologyManager';
import './TopologyManager.scss';

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
 * @param {Set}      props.collapsed    Fold-state set for the live subtree.
 * @param {Function} props.onToggleFold (key) => void fold toggler.
 * @return {import('react').ReactElement} Rendered row.
 */
const TopologyRow = memo( function TopologyRow( {
	topology,
	onActivate,
	onDeactivate,
	onRestart,
	collapsed,
	onToggleFold,
} ) {
	const {
		name,
		source,
		active,
		num_partitions: numPartitions,
		health = 'ok',
		partitions = [],
	} = topology;
	// Swallow a rejected mutation so a failed activate/deactivate/restart never
	// crashes the render (P1: no inline error surfacing yet).
	const fire = ( fn ) => () =>
		Promise.resolve( fn( name ) ).catch( () => {} );
	const section = active ? sectionFor( name, topology.status ) : null;

	return (
		<div className="nodes-tm__topology">
			<div className="nodes-tm__heading">
				<span className="nodes-tm__name">{ name }</span>
				<span className="nodes-tm__sub">
					{ sprintf(
						// translators: %d: number of partitions.
						__( '%d partitions', 'newspack-nodes' ),
						numPartitions
					) }
				</span>
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
				{ active &&
					partitions
						.filter( ( p ) => p.stalled )
						.map( ( p ) => (
							<span
								key={ p.partition }
								className="nodes-tm__pill nodes-tm__pill--stalled"
							>
								{ sprintf(
									// translators: %d: partition number.
									__( 'P%d stalled', 'newspack-nodes' ),
									p.partition
								) }
							</span>
						) ) }
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
						⟳
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
						onRestart={ onRestart }
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
		purgeOrphans,
		connected,
	} = useTopologyManager();
	const [ collapsed, setCollapsed ] = useState( () => new Set() );
	// Transient result of the last Purge orphans run: { text, error } or null.
	const [ purgeResult, setPurgeResult ] = useState( null );
	const onPurge = () => {
		setPurgeResult( null );
		Promise.resolve( purgeOrphans() )
			.then( ( { removed = [], count = 0 } = {} ) => {
				const text =
					count > 0
						? sprintf(
								// translators: 1: count of removed dirs; 2: comma-separated basenames.
								__(
									'Removed %1$d orphan dir(s): %2$s',
									'newspack-nodes'
								),
								count,
								removed.join( ', ' )
						  )
						: __( 'Nothing to purge', 'newspack-nodes' );
				setPurgeResult( { text, error: false } );
			} )
			.catch( ( err ) =>
				setPurgeResult( {
					text:
						err?.message || __( 'Purge failed', 'newspack-nodes' ),
					error: true,
				} )
			);
	};
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

	const sorted = [ ...topologies ].sort( ( a, b ) =>
		a.name.localeCompare( b.name )
	);

	return (
		<div className="nodes-tm">
			<ConnectionBanner
				connectionError={ ! connected }
				message={ __( 'Disconnected — retrying…', 'newspack-nodes' ) }
			/>
			<div className="nodes-tm__toolbar">
				<button
					type="button"
					className="nodes-tm__purge"
					onClick={ onPurge }
				>
					{ __( 'Purge orphans', 'newspack-nodes' ) }
				</button>
				{ purgeResult && (
					<span
						className={ `nodes-tm__purge-result${
							purgeResult.error
								? ' nodes-tm__purge-result--error'
								: ''
						}` }
					>
						{ purgeResult.text }
					</span>
				) }
			</div>
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
					collapsed={ collapsed }
					onToggleFold={ onToggleFold }
				/>
			) ) }
		</div>
	);
}

/**
 * Worker Status Component — one foldable node/log tree section per topology.
 *
 * THIN view over the `workerstatus:*` node graph (mounted by
 * `useWorkerStatusGraph`). The graph owns all data: `workerstatus:poll` runs the
 * dump_graph poll, `workerstatus:transform` computes the read/write rates and
 * segment add/remove tracking, and `workerstatus:view` holds the render model.
 * This component only reads that model (via `useNodeState`) and renders — the
 * supervisor card plus a `TopologySection` per topology (built by
 * `buildTopologySections`), whose fold state is owned here.
 */

import { useEffect, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { useNodeState } from '../runtime/react';
import ConnectionBanner from '@newspack-nodes/shared/components/ConnectionBanner';
import TopologySection from './TopologySection';
import { SupervisorStatus } from './SupervisorStatus';
import { buildTopologySections } from './topologyGraph';
import { formatByteRate } from './formatters';
import {
	useWorkerStatusGraph,
	initialRefresh,
	REFRESH_OPTIONS,
} from './hooks/useWorkerStatusGraph';
import './styles/worker-status.scss';

// Re-exported for backwards-compat (the localStorage migration helper moved into
// the graph hook, which owns the refresh interval). SegmentBar/SupervisorStatus
// re-exported from their new homes so existing importers keep working until the
// module is removed.
export { initialRefresh };
export { SegmentBar } from './SegmentBar';
export { SupervisorStatus } from './SupervisorStatus';

// Persisted fold state: a JSON array of position keys for the collapsed entities.
const COLLAPSED_KEY = 'newspack-nodes-worker-status-collapsed';

// Read the persisted collapsed set; tolerate disabled/quota'd/SSR localStorage
// and malformed JSON by falling back to an empty Set.
function loadCollapsed() {
	if ( typeof window === 'undefined' || ! window.localStorage ) {
		return new Set();
	}
	try {
		const raw = window.localStorage.getItem( COLLAPSED_KEY );
		const keys = raw ? JSON.parse( raw ) : [];
		return new Set( Array.isArray( keys ) ? keys : [] );
	} catch ( e ) {
		return new Set();
	}
}

// Persist the collapsed set; same availability guard as the reader.
function saveCollapsed( set ) {
	if ( typeof window === 'undefined' || ! window.localStorage ) {
		return;
	}
	try {
		window.localStorage.setItem(
			COLLAPSED_KEY,
			JSON.stringify( [ ...set ] )
		);
	} catch ( e ) {
		// localStorage disabled/quota'd; in-session fold state only.
	}
}

// Every entity key currently in the rendered tree (recursing children).
function collectKeys( sections ) {
	const keys = new Set();
	const walk = ( entities ) =>
		entities.forEach( ( e ) => {
			keys.add( e.key );
			if ( e.children ) {
				walk( e.children );
			}
		} );
	sections.forEach( ( s ) => walk( s.tree ) );
	return keys;
}

// The view model before the first poll publishes one — drives the loading gate.
const EMPTY_MODEL = {
	workers: [],
	supervisor: null,
	logs: [],
	byteRates: {},
	writeRates: {},
	segmentSize: 64 * 1024 * 1024,
	currentTime: Math.floor( Date.now() / 1000 ),
	prevSegments: {},
	removingSegments: {},
	graph: {},
	error: null,
	loading: true,
};

/**
 * Worker Status component.
 *
 * @param {Object}  props           Component props.
 * @param {number}  props.refreshMs Refresh interval in milliseconds.
 * @param {boolean} props.fullPage  Whether rendering in full page mode.
 * @return {import('react').ReactElement} Rendered component.
 */
export default function WorkerStatus( { refreshMs = 2000, fullPage = false } ) {
	// Mount the node graph; it owns the poll, the rate/segment math, and the
	// interval. It returns the thin control callbacks + the current interval.
	const {
		restart,
		setRefreshInterval,
		refreshMs: refreshInterval,
	} = useWorkerStatusGraph( { refreshMs } );

	// The single read surface: the enriched render model the graph publishes.
	const model = useNodeState( 'workerstatus:view', 'view' ) ?? EMPTY_MODEL;
	const {
		workers,
		supervisor,
		logs: logsCatalog,
		graph,
		byteRates,
		writeRates,
		segmentSize,
		currentTime,
		prevSegments,
		removingSegments,
		error,
		loading,
	} = model;

	// One node/log tree section per topology: structure from the `.tsl` graph,
	// status overlay from the worker rows + logs catalog.
	const sections = useMemo(
		() => buildTopologySections( graph, workers, logsCatalog ),
		[ graph, workers, logsCatalog ]
	);
	const [ collapsed, setCollapsed ] = useState( loadCollapsed );
	const onToggle = ( key ) =>
		setCollapsed( ( prev ) => {
			const next = new Set( prev );
			if ( next.has( key ) ) {
				next.delete( key );
			} else {
				next.add( key );
			}
			saveCollapsed( next );
			return next;
		} );

	// Trim persisted fold state to what's currently on the page: drop keys for
	// topologies that were removed/renamed (their position keys no longer exist).
	// Skip while empty (still loading) so we don't wipe folds before data lands.
	useEffect( () => {
		if ( ! sections.length ) {
			return;
		}
		const valid = collectKeys( sections );
		setCollapsed( ( prev ) => {
			const next = new Set(
				[ ...prev ].filter( ( k ) => valid.has( k ) )
			);
			if ( next.size === prev.size ) {
				return prev;
			}
			saveCollapsed( next );
			return next;
		} );
	}, [ sections ] );

	if ( loading && workers.length === 0 ) {
		return (
			<div className="worker-status-loading">
				{ __( 'Loading worker status…', 'newspack-nodes' ) }
			</div>
		);
	}

	const containerClass = fullPage ? 'worker-status-full' : 'worker-status';

	// Calculate total read rate across all workers.
	const totalReadRate = Object.values( byteRates ).reduce(
		( sum, rate ) => sum + ( rate || 0 ),
		0
	);

	// Calculate total write rate across all logs.
	const totalWriteRate = Object.values( writeRates ).reduce(
		( sum, rate ) => sum + ( rate || 0 ),
		0
	);

	return (
		<div className={ containerClass }>
			{ ! fullPage && (
				<h3>{ __( 'Worker Status', 'newspack-nodes' ) }</h3>
			) }
			{ fullPage && (
				<div className="worker-status-header">
					<h2>{ __( 'Worker Status', 'newspack-nodes' ) }</h2>
					{ error && (
						<ConnectionBanner
							connectionError={ !! error }
							message={ error }
						/>
					) }
					<div className="worker-status-total-rate">
						<span className="total-rate-write">
							<span className="total-rate-label">
								{ /* translators: abbreviation for "write rate". */ }
								{ __( 'W', 'newspack-nodes' ) }
							</span>
							<span className="total-rate-value">
								{ formatByteRate( totalWriteRate ) }
							</span>
						</span>
						<span className="total-rate-read">
							<span className="total-rate-label">
								{ /* translators: abbreviation for "read rate". */ }
								{ __( 'R', 'newspack-nodes' ) }
							</span>
							<span className="total-rate-value">
								{ formatByteRate( totalReadRate ) }
							</span>
						</span>
					</div>
					<div className="worker-status-controls">
						<select
							className="newspack-nodes-refresh-select"
							value={ refreshInterval }
							onChange={ ( e ) =>
								setRefreshInterval( e.target.value )
							}
							title={ __( 'Refresh interval', 'newspack-nodes' ) }
						>
							{ REFRESH_OPTIONS.map( ( opt ) => (
								<option key={ opt.value } value={ opt.value }>
									{ opt.label }
								</option>
							) ) }
						</select>
					</div>
				</div>
			) }
			{ supervisor && (
				<SupervisorStatus
					supervisor={ supervisor }
					currentTime={ currentTime }
					onRestart={ restart }
				/>
			) }

			<div className="topology-sections">
				{ sections.map( ( section ) => (
					<TopologySection
						key={ section.topology }
						section={ section }
						workers={ section.workers }
						byteRates={ byteRates }
						writeRates={ writeRates }
						segmentSize={ segmentSize }
						currentTime={ currentTime }
						prevSegments={ prevSegments }
						removingSegments={ removingSegments }
						collapsed={ collapsed }
						onToggle={ onToggle }
						onRestart={ restart }
					/>
				) ) }
			</div>
		</div>
	);
}

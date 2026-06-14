/**
 * TreeEntity — one foldable node/log tree entity plus its children.
 *
 * Recursive presentation component over the entity tree built by
 * `topologyGraph.buildTopologySections`. A `node` entity renders a compact
 * per-partition worker row (status pill + R-rate + behind + ETA +
 * restart_pending); a `log` entity renders its per-partition segment bars
 * (reusing `SegmentBar`). Folding is owned by the caller via the
 * `collapsed` Set + `onToggle` callback.
 */

import { memo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { SegmentBar } from './WorkerStatus';
import { formatByteRate, formatBytes, formatEta } from './formatters';

// A log keeps its filename; a node name is Title-Cased from its slug.
const displayName = ( name ) =>
	name.includes( '.' )
		? name
		: name
				.split( '-' )
				.map( ( w ) => w.charAt( 0 ).toUpperCase() + w.slice( 1 ) )
				.join( ' ' );

function NodeRow( { entity, byteRates } ) {
	const sorted = [ ...entity.workers ].sort(
		( a, b ) => a.partition - b.partition
	);
	return (
		<span className="tree-node-row">
			{ sorted.map( ( wkr ) => {
				const key = `${ wkr.handler || wkr.type }-${ wkr.partition }-${
					wkr.source || ''
				}`;
				const rate = byteRates[ key ];
				return (
					<span key={ wkr.partition } className="connector-partition">
						<span
							className={ `worker-status-badge compact ${ wkr.status }` }
						>
							P{ wkr.partition }
						</span>
						<span
							className={ `connector-rate ${
								wkr.status === 'dead' ? 'dead' : ''
							}` }
						>
							R { formatByteRate( rate ) }
						</span>
						{ wkr.behind > 0 && (
							<span
								className={ `connector-behind ${
									wkr.behind > 1024 * 1024 ? 'warning' : ''
								}` }
							>
								{ formatBytes( wkr.behind ) }
							</span>
						) }
						{ wkr.behind > 0 && (
							<span
								className={ `connector-eta ${
									! rate || rate <= 0 ? 'stalled' : ''
								}` }
							>
								{ formatEta( wkr.behind, rate ) }
							</span>
						) }
						{ wkr.restart_pending && (
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
				);
			} ) }
		</span>
	);
}

function LogRows( {
	entity,
	writeRates,
	segmentSize,
	prevSegments,
	removingSegments,
} ) {
	const sorted = [ ...entity.partitions ].sort(
		( a, b ) => a.partition - b.partition
	);
	const logKey = entity.name.replace( /\.log$/, '' );
	return sorted.map( ( p ) => {
		const rateKey = `${ logKey }-${ p.partition }`;
		const segs = p.segments || [];
		const newestSegId = segs.length
			? Math.max( ...segs.map( ( s ) => s.id ) )
			: 0;
		const cursor =
			entity.hasCursor &&
			p.cursor_seg !== undefined &&
			p.cursor_seg !== null
				? { seg: p.cursor_seg, offset: p.cursor_offset }
				: undefined;
		const removing = removingSegments[ rateKey ] || [];
		const all = [ ...removing, ...segs ].sort( ( a, b ) => a.id - b.id );
		const removingIds = new Set( removing.map( ( s ) => s.id ) );
		return (
			<div key={ p.partition } className="log-partition-row">
				<div className="log-partition-info">
					<span className="partition-label-inline">
						P{ p.partition }
					</span>
					<span className="log-write-rate">
						{ entity.hasCursor ? 'R' : 'W' }{ ' ' }
						{ formatByteRate( writeRates[ rateKey ] ) }
					</span>
				</div>
				<div className="partition-segments">
					{ all.map( ( seg ) => (
						<SegmentBar
							key={ seg.id }
							segment={ seg }
							maxSize={ entity.segment_size || segmentSize }
							cursorSeg={ cursor?.seg }
							cursorOffset={ cursor?.offset }
							newestSegId={ newestSegId }
							isNew={
								prevSegments?.[ rateKey ] &&
								! prevSegments[ rateKey ].has( seg.id )
							}
							isRemoving={ removingIds.has( seg.id ) }
						/>
					) ) }
					{ all.length === 0 && (
						<div className="no-segments-h">
							{ __( 'No segments', 'newspack-nodes' ) }
						</div>
					) }
				</div>
			</div>
		);
	} );
}

const TreeEntity = memo( function TreeEntity( props ) {
	const { entity, depth, collapsed, onToggle } = props;
	const isCollapsed = collapsed.has( entity.key );
	const hasChildren = entity.children.length > 0;
	return (
		<div className={ `tree-branch ${ isCollapsed ? 'collapsed' : '' }` }>
			<div className="tree-ent" style={ { marginLeft: depth * 14 } }>
				<div className="row">
					<span
						className="caret"
						role="button"
						tabIndex={ 0 }
						onClick={ () => onToggle( entity.key ) }
						onKeyDown={ ( e ) => {
							if ( e.key === 'Enter' || e.key === ' ' ) {
								onToggle( entity.key );
							}
						} }
					>
						▾
					</span>
					{ entity.kind === 'log' ? (
						<span className="log-name">{ entity.name }</span>
					) : (
						<span className="connector-name">
							{ displayName( entity.name ) }
						</span>
					) }
					{ entity.kind === 'node' && (
						<NodeRow
							entity={ entity }
							byteRates={ props.byteRates }
						/>
					) }
				</div>
				{ ! isCollapsed && entity.kind === 'log' && (
					<LogRows entity={ entity } { ...props } />
				) }
			</div>
			{ ! isCollapsed && hasChildren && (
				<div className="tree-kids">
					{ entity.children.map( ( child ) => (
						<TreeEntity
							key={ child.key }
							{ ...props }
							entity={ child }
							depth={ depth + 1 }
						/>
					) ) }
				</div>
			) }
		</div>
	);
} );

export default TreeEntity;

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
import { SegmentBar } from './SegmentBar';
import { formatByteRate, formatBytes, formatEta } from './formatters';

/**
 * Props for the worker row of a `node` entity.
 *
 * @typedef {Object} NodeRowProps
 * @property {Object} entity A `node` entity from
 *                           `buildTopologySections`; its
 *                           `workers` array carries one live
 *                           row per partition, each carrying
 *                           its own `read_rate`.
 */

/**
 * The status strip of a `node` entity: one badge per partition, each carrying
 * that worker's read rate, backlog, ETA, and restart-pending marker.
 *
 * @type {import('react').NamedExoticComponent<NodeRowProps>}
 */
const NodeRow = memo( function NodeRow( { entity } ) {
	const sorted = [ ...entity.workers ].sort(
		( a, b ) => a.partition - b.partition
	);
	return (
		<span className="tree-node-row">
			{ sorted.map( ( wkr ) => {
				// The row carries its own rate; no side-map key to rebuild.
				const rate = wkr.read_rate;
				return (
					<span key={ wkr.partition } className="connector-partition">
						<span
							className={ `newspack-nodes-status-badge worker-status-badge compact ${ wkr.status }` }
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
} );

/**
 * Props for the per-partition rows of a `log` entity.
 *
 * `prevSegments` and `removingSegments` drive the segment animations. Both are
 * keyed by CONCRETE partition name (`firehose.p0`), the same key `writeRates`
 * uses.
 *
 * @typedef {Object} LogRowsProps
 * @property {Object}                entity           A `log` entity from
 *                                                    `buildTopologySections`;
 *                                                    its `partitions` array
 *                                                    carries one entry per
 *                                                    concrete catalog partition.
 * @property {Object<string,number>} writeRates       Write rate in bytes per
 *                                                    second.
 * @property {number}                segmentSize      Fleet-wide segment size in
 *                                                    bytes, scaling the bars of
 *                                                    a log that declares none of
 *                                                    its own.
 * @property {Object}                prevSegments     The PRIOR snapshot's
 *                                                    segment ids, each value a
 *                                                    `Set`; a segment missing
 *                                                    from it animates in.
 * @property {Object}                removingSegments Segments gone since the
 *                                                    prior snapshot, each value
 *                                                    an array, drawn until they
 *                                                    finish animating out.
 */

/**
 * One `log` entity's per-partition rows: the partition's write rate and its
 * segment bars, departed segments included so they can animate out.
 *
 * @type {import('react').NamedExoticComponent<LogRowsProps>}
 */
const LogRows = memo( function LogRows( {
	entity,
	writeRates,
	segmentSize,
	prevSegments,
	removingSegments,
} ) {
	// One sub-row per partition; rate key = partition's CONCRETE catalog name.
	const sorted = [ ...entity.partitions ].sort(
		( a, b ) => a.partition - b.partition
	);
	return sorted.map( ( p ) => {
		const rateKey = p.name;
		const segs = p.segments || [];
		// cursor + end arrive together; no consumer → SegmentBar paints gray.
		const cursor =
			entity.hasCursor &&
			p.cursor_segment !== undefined &&
			p.cursor_segment !== null
				? {
						segment: p.cursor_segment,
						offset: p.cursor_offset,
						endSegment: p.end_segment,
						endSize: p.end_size,
				  }
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
						{ /* A log shows its WRITE rate, not read rate. */ }W{ ' ' }
						{ formatByteRate( writeRates[ rateKey ] ) }
					</span>
				</div>
				<div className="partition-segments">
					{ all.map( ( seg, index ) => (
						<SegmentBar
							key={ seg.id }
							segment={ seg }
							index={ index }
							maxSize={ entity.segment_size || segmentSize }
							cursorSegment={ cursor?.segment }
							cursorOffset={ cursor?.offset }
							endSegment={ cursor?.endSegment }
							endSize={ cursor?.endSize }
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
} );

/**
 * Props for one entity of a topology tree. Everything but `entity` and `depth`
 * passes straight down to the children, so one call renders a whole subtree.
 *
 * @typedef {Object} TreeEntityProps
 * @property {Object}                entity           The entity to render: its
 *                                                    `kind` is `node` or `log`,
 *                                                    its `children` are the
 *                                                    entities beneath it.
 * @property {number}                depth            Nesting level; each level
 *                                                    indents 14px.
 * @property {Set<string>}           collapsed        Keys of the folded
 *                                                    entities, owned by the
 *                                                    caller.
 * @property {Function}              onToggle         Called with an entity key
 *                                                    to fold or unfold it.
 * @property {Object<string,number>} writeRates       Write rates, for `LogRows`.
 * @property {number}                segmentSize      Fleet-wide segment size in
 *                                                    bytes.
 * @property {Object}                prevSegments     The PRIOR snapshot's
 *                                                    segment ids per partition
 *                                                    name.
 * @property {Object}                removingSegments Segments gone since the
 *                                                    prior snapshot, per
 *                                                    partition name.
 */

/**
 * One foldable tree entity plus, unless it is collapsed, its children.
 *
 * @type {import('react').NamedExoticComponent<TreeEntityProps>}
 */
const TreeEntity = memo( function TreeEntity( props ) {
	const {
		entity,
		depth,
		collapsed,
		onToggle,
		writeRates,
		segmentSize,
		prevSegments,
		removingSegments,
	} = props;
	const isCollapsed = collapsed.has( entity.key );
	const hasChildren = entity.children.length > 0;
	return (
		<div className={ `tree-branch ${ isCollapsed ? 'collapsed' : '' }` }>
			<div className="tree-ent" style={ { marginLeft: depth * 14 } }>
				<div className="row">
					<span
						className="newspack-nodes-disclosure caret"
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
							{ entity.names
								? entity.names.join( ', ' )
								: entity.name }
						</span>
					) }
					{ entity.kind === 'node' && <NodeRow entity={ entity } /> }
				</div>
				{ ! isCollapsed && entity.kind === 'log' && (
					<LogRows
						entity={ entity }
						writeRates={ writeRates }
						segmentSize={ segmentSize }
						prevSegments={ prevSegments }
						removingSegments={ removingSegments }
					/>
				) }
			</div>
			{ ! isCollapsed && hasChildren && (
				<div className="tree-kids">
					{ entity.children.map( ( child ) => (
						<TreeEntity
							key={ child.key }
							entity={ child }
							depth={ depth + 1 }
							collapsed={ collapsed }
							onToggle={ onToggle }
							writeRates={ writeRates }
							segmentSize={ segmentSize }
							prevSegments={ prevSegments }
							removingSegments={ removingSegments }
						/>
					) ) }
				</div>
			) }
		</div>
	);
} );

export default TreeEntity;

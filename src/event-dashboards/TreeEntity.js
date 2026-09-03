/**
 * Renders one topology's node/log tree: what each worker is doing, and how far
 * behind each log's readers are.
 *
 * `topologyGraph.buildTopologySections` builds the entity tree; this component
 * walks it, one instance per entity. A `node` entity draws a status strip of
 * per-partition worker pills. A `log` entity draws one row per partition,
 * carrying that partition's write rate and its segment bars, one `SegmentBar`
 * each.
 *
 * The caller owns the fold state and passes it in as a `collapsed` Set plus an
 * `onToggle` callback. Overview keeps ONE Set across every topology and
 * persists it, so fold state has to outlive any tree rendered here.
 */

import { memo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { SegmentBar } from './SegmentBar';
import {
	formatByteRate,
	formatBytes,
	formatEta,
} from '@newspack-nodes/shared/utils/formatters';

/**
 * Props for the status strip of a `node` entity.
 *
 * @typedef {Object} NodeRowProps
 * @property {Object} entity A `node` entity from
 *                           `buildTopologySections`, its `workers`
 *                           array already narrowed to the rows this
 *                           branch owns. Dead partitions are among
 *                           them, and a row that no consumer probe
 *                           reached carries no `read_rate`, which
 *                           reads as 0 B/s.
 */

/**
 * The status strip of a `node` entity: one pill per partition, carrying that
 * worker's read rate, its backlog and ETA once it falls behind, and a marker
 * while a restart is pending.
 *
 * The pills sort by partition number so the strip reads P0, P1, … whatever
 * order the worker rows arrive in.
 *
 * The rate comes off the worker row itself. The model's `byteRates` map is
 * keyed by READER id, which no tree entity carries, so reading the rate there
 * would mean rebuilding a key the row already answers.
 *
 * A pill flags its own trouble through three modifier classes the stylesheet
 * colors: `dead` strikes the rate through, a backlog past 1 MB adds `warning`,
 * and a read rate of zero adds `stalled` to the ETA.
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
 * `writeRates`, `prevSegments` and `removingSegments` are all keyed by the
 * CONCRETE partition name (`firehose.p0`) that `reconstructWorkers` records
 * against, never the logical name the entity displays.
 *
 * A segment missing from its partition's `prevSegments` entry animates in, so a
 * partition with no entry at all — the first snapshot — animates nothing.
 *
 * @typedef {Object} LogRowsProps
 * @property {Object}                       entity           A `log` entity from
 *                                                           `buildTopologySections`;
 *                                                           its `partitions` array
 *                                                           holds one entry per
 *                                                           concrete catalog partition.
 * @property {Object<string,number>}        writeRates       Bytes written per second.
 * @property {number}                       segmentSize      Fleet-wide segment size in
 *                                                           bytes, scaling the bars of
 *                                                           a log that declares none of
 *                                                           its own.
 * @property {Object<string,Set<number>>}   prevSegments     The prior snapshot's
 *                                                           segment ids.
 * @property {Object<string,Array<Object>>} removingSegments Segments gone since the
 *                                                           prior snapshot, drawn
 *                                                           until they finish
 *                                                           animating out.
 */

/**
 * One `log` entity's per-partition rows: the partition's write rate and its
 * segment bars, departed segments included so they can animate out.
 *
 * The rows sort by partition number, and a departed segment sorts back among
 * the live ones by id, so it holds its place in the row while it animates out.
 *
 * Memoized on those five props, so a log skips re-rendering its bars when the
 * parent re-renders for another reason — a fold toggling, or the per-poll
 * `currentTime` that reaches `TreeEntity` and stops there.
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
	const sorted = [ ...entity.partitions ].sort(
		( a, b ) => a.partition - b.partition
	);
	return sorted.map( ( p ) => {
		const rateKey = p.name;
		const segs = p.segments || [];
		// Cursor and end travel together; no cursor means a gray bar.
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
						{ /* A log shows the WRITE rate, not a read rate. */ }W{ ' ' }
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
 * @property {Object}                       entity           The entity to render: its
 *                                                           `kind` is `node` or `log`,
 *                                                           its `children` are the
 *                                                           entities beneath it, and a
 *                                                           joined node also carries
 *                                                           `names`, the members it
 *                                                           stands for.
 * @property {number}                       depth            Nesting level; each level
 *                                                           indents 14px.
 * @property {Set<string>}                  collapsed        Keys of the folded
 *                                                           entities, owned by the
 *                                                           caller.
 * @property {(key: string) => void}        onToggle         Called with an entity key
 *                                                           to fold or unfold it.
 * @property {Object<string,number>}        writeRates       Write rates, for `LogRows`.
 * @property {number}                       segmentSize      Fleet-wide segment size in
 *                                                           bytes.
 * @property {Object<string,Set<number>>}   prevSegments     The prior snapshot's
 *                                                           segment ids per partition
 *                                                           name.
 * @property {Object<string,Array<Object>>} removingSegments Segments gone since the
 *                                                           prior snapshot, per
 *                                                           partition name.
 */

/**
 * One foldable tree entity plus, unless it is collapsed, its children.
 *
 * Folding hides the children and a log's partition rows. A node's status strip
 * stays, so a folded branch still reports whether its workers run. Every entity
 * carries a caret, leaves included, because a leaf log still has partition rows
 * to fold.
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

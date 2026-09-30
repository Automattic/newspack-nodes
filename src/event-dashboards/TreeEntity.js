/**
 * Draws a topology's node/log tree: what each worker is doing, and how far
 * behind each log's readers are.
 *
 * `topologyGraph.buildTopologySections` builds the entity tree; this component
 * renders one entity of it and recurses into that entity's children, so
 * `TopologySection`'s call on a root paints the whole subtree. A `node` entity
 * draws a status strip of per-partition worker pills. A `log` entity draws one
 * row per partition, carrying that partition's write rate and its segment
 * bars, one `SegmentBar` each.
 *
 * The caller owns the fold state and passes it in as a `collapsed` Set plus an
 * `onToggle` callback. Overview keeps ONE Set across every topology and
 * persists it, so fold state has to outlive any tree rendered here.
 */

import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
} from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { SegmentBar, segmentRegions } from './SegmentBar';
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
 * colors: `stopped` strikes a non-live rate through, a backlog past 1 MB adds `warning`,
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
							className={ `newspack-nodes-status-badge worker-status-badge compact ${ wkr.state }` }
						>
							P{ wkr.partition }
						</span>
						<span
							className={ `connector-rate ${
								'live' === wkr.state ? '' : 'stopped'
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
 * @typedef {Object} LogRowsProps
 * @property {Object}                       entity           A `log` entity from
 *                                                           `buildTopologySections`;
 *                                                           its `partitions` array
 *                                                           holds one entry per
 *                                                           concrete catalog partition,
 *                                                           and `hasCursor` says whether
 *                                                           any reader reported a
 *                                                           position. The flag is OR'd
 *                                                           across the partitions, so a
 *                                                           partition no consumer reads
 *                                                           still draws gray bars.
 * @property {Object<string,number>}        writeRates       Bytes written per second.
 * @property {number}                       segmentSize      Fleet-wide segment size in
 *                                                           bytes, scaling the bars of
 *                                                           a log that declares none of
 *                                                           its own.
 * @property {Object<string,Set<number>>}   prevSegments     The prior snapshot's
 *                                                           segment ids. A fresh object
 *                                                           each poll, and missing a
 *                                                           partition when the transform
 *                                                           holds no baseline for it.
 * @property {Object<string,Array<Object>>} removingSegments This poll's departed
 *                                                           segments.
 */

/**
 * What one bar last drew: its size, and its regions as one comparable key.
 *
 * @typedef {{size: number, key: string}} DrawnBar
 */

/**
 * The motion baseline: what the rows drew before the poll `poll` names, and
 * what they have drawn since. It advances once per poll, never per render.
 *
 * @typedef {Object} Baseline
 * @property {?Object}                          poll   The `prevSegments` object of
 *                                                     the poll last committed.
 * @property {Map<string,Map<number,DrawnBar>>} before What the rows drew before it.
 * @property {Map<string,Map<number,DrawnBar>>} drawn  What they drew at its commit.
 */

/**
 * One bar's regions and how it moves on this render: the props `SegmentBar`
 * takes beyond the segment and the scale.
 *
 * @typedef {Object} BarPlan
 * @property {number}  read       Bytes read.
 * @property {number}  recorded   Bytes up to the recorded end.
 * @property {boolean} crossed    The backlog crossed out of the cursor's segment.
 * @property {number}  stagger    Cascade steps before its fill moves.
 * @property {boolean} snap       Draw final widths with no fill transition.
 * @property {boolean} isNew      Arrived since the baseline, so it slides in.
 * @property {boolean} isRemoving Departed, so it slides out.
 */

/**
 * Every bar of one partition row, in id order, with its regions and motion.
 *
 * The tail is the newest live segment; every other bar has a newer one to its
 * right. A bar snaps to its final widths when it is not the tail and either
 * arrived since the baseline or changed size, because it rotated: its growth
 * happened between polls and replaying it would show an empty track where the
 * data is full. Every other change animates, and the cascade counts from the
 * first animated bar, so a change confined to the tail starts at once. With
 * no baseline — a first draw, or the poll after a hidden-tab gap — nothing
 * moves. A departing bar keeps its place by id and only slides out.
 *
 * @param {Object}               p         One entry of a log entity's
 *                                         `partitions`.
 * @param {boolean}              hasCursor Whether any reader of the log
 *                                         reported a position.
 * @param {Array<Object>}        leaving   The row's departed segments.
 * @param {?Set<number>}         prevIds   The prior snapshot's ids for the row.
 * @param {Map<number,DrawnBar>} [base]    What the row drew before this poll;
 *                                         undefined when there is no baseline.
 * @return {{bars: Array<{segment: Object, plan: BarPlan}>,
 *   next: Map<number,DrawnBar>}} The row's bars, and what this render draws.
 */
function planRow( p, hasCursor, leaving, prevIds, base ) {
	// Cursor and end travel together; no cursor means a gray row.
	const cursor =
		hasCursor && p.cursor_segment !== undefined && p.cursor_segment !== null
			? {
					segment: p.cursor_segment,
					offset: p.cursor_offset,
					endSegment: p.end_segment,
					endSize: p.end_size,
			  }
			: undefined;
	const live = [ ...( p.segments || [] ) ].sort( ( a, b ) => a.id - b.id );
	const tailId = live.length > 0 ? live[ live.length - 1 ].id : null;
	const next = new Map();
	const planned = live.map( ( segment ) => {
		const regions = segmentRegions( segment, cursor );
		const now = {
			size: segment.size,
			key: `${ segment.size }:${ regions.read }:${ regions.recorded }`,
		};
		next.set( segment.id, now );
		const before = base?.get( segment.id );
		const isNew = !! base && ! before && ! prevIds.has( segment.id );
		const snap =
			segment.id !== tailId &&
			( isNew || ( !! before && before.size !== now.size ) );
		const animated =
			! snap && ( isNew || ( !! before && before.key !== now.key ) );
		return { segment, regions, isNew, snap, animated };
	} );
	const first = planned.findIndex( ( b ) => b.animated );
	const bars = [
		...leaving.map( ( segment ) => ( {
			segment,
			plan: {
				...segmentRegions( segment, cursor ),
				stagger: 0,
				snap: false,
				isNew: false,
				isRemoving: true,
			},
		} ) ),
		...planned.map( ( b, i ) => ( {
			segment: b.segment,
			plan: {
				...b.regions,
				stagger: b.animated ? i - first : 0,
				snap: b.snap,
				isNew: b.isNew,
				isRemoving: false,
			},
		} ) ),
	].sort( ( a, b ) => a.segment.id - b.segment.id );
	return { bars, next };
}

/**
 * A departure in flight: the row it leaves, and the segment it draws.
 *
 * @typedef {{row: string, segment: Object}} Departure
 */

/**
 * The departed bars `LogRows` holds, both keyed `row#id`, so one departure
 * offered by any number of renders is one entry.
 *
 * @typedef {Object} Departures
 * @property {Map<string,Departure>} held Departures still sliding out.
 * @property {Set<string>}           gone Offered departures that already slid
 *                                        out, which an offer must not revive.
 */

/**
 * The key one departure is held and retired under.
 *
 * @param {string} row Concrete partition name.
 * @param {number} id  Segment id.
 * @return {string} `row#id`.
 */
const departureKey = ( row, id ) => `${ row }#${ id }`;

/**
 * The departures `removingSegments` offers the partitions drawn here, by key.
 * A row this component does not draw offers none, so nothing accumulates off
 * screen.
 *
 * @param {Object<string,Array<Object>>} incoming This poll's departures, by row.
 * @param {Array<Object>}                rows     The partitions drawn here.
 * @return {Map<string,Departure>} The offered departures.
 */
function offeredDepartures( incoming, rows ) {
	const offered = new Map();
	rows.forEach( ( { name } ) =>
		( incoming[ name ] || [] ).forEach( ( segment ) =>
			offered.set( departureKey( name, segment.id ), {
				row: name,
				segment,
			} )
		)
	);
	return offered;
}

/**
 * Join the offered departures to the held ones, idempotently by key. An offer
 * already held or already gone adds nothing, and a gone key no longer offered
 * is forgotten, because the transform reports a departure in one poll only.
 *
 * @param {Departures}            state   What the row holds now.
 * @param {Map<string,Departure>} offered What `removingSegments` offers.
 * @return {?Departures} The joined state, or null when nothing changed.
 */
function joinDepartures( state, offered ) {
	const gone = new Set(
		[ ...state.gone ].filter( ( key ) => offered.has( key ) )
	);
	const held = new Map( state.held );
	offered.forEach( ( departure, key ) => {
		if ( ! held.has( key ) && ! gone.has( key ) ) {
			held.set( key, departure );
		}
	} );
	return held.size !== state.held.size || gone.size !== state.gone.size
		? { held, gone }
		: null;
}

/**
 * One `log` entity's per-partition rows: the partition's write rate and its
 * segment bars, departed segments included so they can animate out.
 *
 * The rows sort by partition number, and a departed segment sorts back among
 * the live ones by id, so it holds its place in the row while it animates out.
 *
 * The departed bars are this component's own state. Every render joins what
 * `removingSegments` offers, keyed by row and segment id, so an equal object
 * rebuilt each render adds nothing, and a bar leaves when its own slide-out
 * ends. A folded row unmounts and takes its departures with it, and a
 * remounted one ignores what was offered before it mounted, so nothing waits
 * on a bar that is not drawn.
 *
 * The motion baseline is this component's too, because the cursor is this
 * topology's own and no earlier stage of the graph holds THIS tree's widths.
 * It advances once per poll, keyed by `prevSegments`, so a re-render between
 * polls plans against the same baseline as the poll's own render.
 *
 * Memoized on its five props, so a log skips re-rendering its bars when the
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
	// A departure offered before this row mounted is not this row's to draw.
	const [ departures, setDepartures ] = useState( () => ( {
		held: new Map(),
		gone: new Set(
			offeredDepartures( removingSegments, entity.partitions ).keys()
		),
	} ) );
	const joined = joinDepartures(
		departures,
		offeredDepartures( removingSegments, entity.partitions )
	);
	if ( joined ) {
		setDepartures( joined );
	}
	const leaving = [ ...( joined ?? departures ).held.values() ];
	const slidOut = useCallback(
		( row, id ) =>
			setDepartures( ( { held, gone } ) => {
				const key = departureKey( row, id );
				const left = new Map( held );
				left.delete( key );
				return { held: left, gone: new Set( gone ).add( key ) };
			} ),
		[]
	);

	/** @type {import('react').MutableRefObject<Baseline>} */
	const baseline = useRef( {
		poll: null,
		before: new Map(),
		drawn: new Map(),
	} );
	const { poll, before, drawn } = baseline.current;
	const base = poll === prevSegments ? before : drawn;
	/** @type {Map<string,Map<number,DrawnBar>>} */
	const drawnNow = new Map();
	useEffect( () => {
		const last = baseline.current;
		baseline.current =
			last.poll === prevSegments
				? { ...last, drawn: drawnNow }
				: { poll: prevSegments, before: last.drawn, drawn: drawnNow };
	} );

	const sorted = [ ...entity.partitions ].sort(
		( a, b ) => a.partition - b.partition
	);
	return sorted.map( ( p ) => {
		const rateKey = p.name;
		const prevIds = prevSegments?.[ rateKey ];
		const { bars, next } = planRow(
			p,
			entity.hasCursor,
			leaving
				.filter( ( d ) => d.row === rateKey )
				.map( ( d ) => d.segment ),
			prevIds,
			prevIds ? base.get( rateKey ) : undefined
		);
		drawnNow.set( rateKey, next );
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
					{ bars.map( ( { segment, plan } ) => (
						<SegmentBar
							key={ segment.id }
							segment={ segment }
							maxSize={ entity.segment_size || segmentSize }
							{ ...plan }
							onSlidOut={
								plan.isRemoving
									? ( id ) => slidOut( rateKey, id )
									: undefined
							}
						/>
					) ) }
					{ bars.length === 0 && (
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
 * @property {number}                       depth            Nesting level; the row's
 *                                                           left margin is `depth * 14`
 *                                                           pixels.
 * @property {Set<string>}                  collapsed        Keys of the folded
 *                                                           entities, owned by the
 *                                                           caller.
 *                                                           `buildTopologySections`
 *                                                           scopes every key to its
 *                                                           topology, so one Set shared
 *                                                           across topologies folds each
 *                                                           of them independently.
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

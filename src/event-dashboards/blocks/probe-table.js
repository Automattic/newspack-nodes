/**
 * The probe-table block: one row per identity a probe log names — a job
 * handler on `jobstats.p0`, a Table on `tablestats.p0` — with the window's
 * totals, summed over the same buckets the charts plot, worst first by its
 * errors, or its empty state while its log has reported nothing, a view yet
 * to publish included.
 *
 * It is its own block because a probe row is not a list of formatted values: a
 * cell wears a status badge, marks a non-zero error count, or reads '-' for a
 * level whose newest record has left the live window, each judged against
 * the stream's own head, which the shared table cannot express.
 */

import { SelectControl } from '@wordpress/components';
import { useDeferredValue, useMemo } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { useSource } from '@newspack-nodes/shared/sources';
import Unread from '@newspack-nodes/shared/components/Unread';
import {
	formatBytes,
	formatGroupedCount,
	formatAge,
} from '@newspack-nodes/shared/utils/formatters';
import { formatDuration } from '@newspack-nodes/shared/utils/formatUtils';
import { ProbeTable, errorsColumn } from '../ProbeTable';
import { byKey } from '../topicProbeSeries';
import { isLiveSample, streamHead } from '../liveSample';
import '../styles/probe-tab.scss';
import '../styles/jobs.scss';

/**
 * The identity table's columns. A mean or max over a window with no runs is
 * null, which `formatDuration` reads as '-'; `ctx.nowSec` dates the last run.
 *
 * @type {Array<import('../ProbeTable').ProbeColumn>}
 */
const JOB_COLUMNS = [
	{
		label: __( 'Job', 'newspack-nodes' ),
		cell: byKey,
		td: () => ( { className: 'nodes-probe-tab__name' } ),
	},
	{
		label: __( 'Runs', 'newspack-nodes' ),
		cell: ( row ) => formatGroupedCount( row.windowed.runs ),
	},
	errorsColumn( __( 'Failures', 'newspack-nodes' ) ),
	{
		label: __( 'Avg', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.windowed.avgDurationMs ),
	},
	{
		label: __( 'Max', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.windowed.maxDurationMs ),
	},
	{
		label: __( 'Last', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.latest.lastDurationMs ),
	},
	{
		label: __( 'Queued', 'newspack-nodes' ),
		cell: ( row ) => formatDuration( row.windowed.avgQueueMs ),
	},
	{
		label: __( 'Status', 'newspack-nodes' ),
		cell: ( row ) => (
			<span
				className={ `newspack-nodes-status-badge nodes-jobs__status is-${ row.latest.lastStatus }` }
			>
				{ row.latest.lastStatus }
			</span>
		),
	},
	{
		label: __( 'Message', 'newspack-nodes' ),
		cell: ( row ) => row.latest.lastMessage,
		td: ( row ) => ( {
			className: 'nodes-jobs__message',
			title: row.latest.lastMessage,
		} ),
	},
	{
		label: __( 'Last run', 'newspack-nodes' ),
		cell: ( row, ctx ) =>
			row.latest.lastTs
				? formatAge( row.latest.lastTs, ctx.nowSec )
				: '-',
	},
];

/**
 * The WAL cell: frames written of frames asked, and a stall count when a live
 * Table's checkpoint is stuck. '-' where the record carries no WAL.
 *
 * @param {{windowed:Object,latest:Object}} t    A Table entry.
 * @param {boolean}                         live Its newest record is current.
 * @return {string} The label.
 */
function walLabel( t, live ) {
	const { walStalled } = t.latest;
	if ( null === walStalled ) {
		return '-';
	}
	const { walWritten, walFrames } = t.windowed;
	const base = `${ formatGroupedCount( walWritten ) } / ${ formatGroupedCount(
		walFrames
	) }`;
	return live && walStalled > 0
		? `${ base } · ${ __(
				'stalled',
				'newspack-nodes'
		  ) } ${ formatGroupedCount( walStalled ) }`
		: base;
}

/**
 * The purge-backlog cell: whether a live Table's purge is behind, '-' where
 * the record says it purges nothing.
 *
 * @param {{latest:Object}} t    A Table entry.
 * @param {boolean}         live Its newest record is current.
 * @return {string} The label.
 */
function purgeBehindLabel( t, live ) {
	const { purgeBehind } = t.latest;
	if ( null === purgeBehind || ! live ) {
		return '-';
	}
	return purgeBehind
		? __( 'behind', 'newspack-nodes' )
		: __( 'no', 'newspack-nodes' );
}

/**
 * The Table table's columns. `ctx.head` is the stream head a level's
 * freshness is judged against.
 *
 * @type {Array<import('../ProbeTable').ProbeColumn>}
 */
const TABLE_COLUMNS = [
	{
		label: __( 'Table', 'newspack-nodes' ),
		cell: byKey,
		td: () => ( { className: 'nodes-probe-tab__name' } ),
	},
	{ label: __( 'Backend', 'newspack-nodes' ), cell: ( t ) => t.backend },
	{
		label: __( 'Ops', 'newspack-nodes' ),
		cell: ( t ) => formatGroupedCount( t.windowed.ops ),
	},
	{
		label: __( 'Hit %', 'newspack-nodes' ),
		cell: ( t ) =>
			null === t.windowed.hitPct
				? '-'
				: `${ t.windowed.hitPct.toFixed( 1 ) }%`,
	},
	{
		label: __( 'Avg', 'newspack-nodes' ),
		cell: ( t ) => formatDuration( t.windowed.meanMs ),
	},
	{
		label: __( 'Max', 'newspack-nodes' ),
		cell: ( t ) => formatDuration( t.windowed.maxMs ),
	},
	{
		label: __( 'Size', 'newspack-nodes' ),
		cell: ( t, ctx ) =>
			null !== t.latest.fileBytes && isLiveSample( t.latest, ctx.head )
				? sprintf(
						// translators: 1: bytes the files hold, 2: disk they take.
						__( '%1$s (%2$s on disk)', 'newspack-nodes' ),
						formatBytes( t.latest.fileBytes ),
						formatBytes( t.latest.fileDiskBytes )
				  )
				: '-',
	},
	errorsColumn( __( 'Errors', 'newspack-nodes' ) ),
	{
		label: __( 'Purged', 'newspack-nodes' ),
		cell: ( t ) =>
			null === t.latest.purgeBehind
				? '-'
				: formatGroupedCount( t.windowed.purged ),
	},
	{
		label: __( 'Purge behind', 'newspack-nodes' ),
		cell: ( t, ctx ) =>
			purgeBehindLabel( t, isLiveSample( t.latest, ctx.head ) ),
	},
	{
		label: __( 'WAL', 'newspack-nodes' ),
		cell: ( t, ctx ) => walLabel( t, isLiveSample( t.latest, ctx.head ) ),
	},
];

/**
 * Worst first by windowed errors, then by name.
 *
 * @param {Object<string,Object>} entries The view's identities.
 * @return {Array<Object>} The rows.
 */
const worstFirst = ( entries ) =>
	Object.entries( entries ?? {} )
		.map( ( [ key, entry ] ) => ( { ...entry, key } ) )
		.sort(
			( a, b ) =>
				b.windowed.errors - a.windowed.errors ||
				a.key.localeCompare( b.key )
		);

/**
 * How each probe source's table is presented: the words the inspector names
 * it by, its columns, rows, the data attribute keying a row, what every cell
 * is handed beside its row, and its empty state. Which probes a block may
 * read is the declared `source` schema's `enum` alone.
 */
const TABLES = {
	'nodes/jobstats': {
		label: __( 'Jobs', 'newspack-nodes' ),
		columns: JOB_COLUMNS,
		rows: ( view ) => worstFirst( view.handlers ),
		keyAttr: 'data-job-key',
		context: () => ( { nowSec: Math.floor( Date.now() / 1000 ) } ),
		empty: __( 'No job activity yet.', 'newspack-nodes' ),
	},
	'nodes/tablestats': {
		label: __( 'Tables', 'newspack-nodes' ),
		columns: TABLE_COLUMNS,
		rows: ( view ) => worstFirst( view.tables ),
		keyAttr: 'data-table-key',
		context: ( view ) => ( { head: streamHead( view.tables ) } ),
		empty: __( 'No Table has reported yet.', 'newspack-nodes' ),
	},
};

/**
 * @param {{attributes: {source: string}}} props The block's attributes.
 * @return {import('react').ReactElement} The table.
 */
function View( { attributes: { source } } ) {
	const table = TABLES[ source ];
	const { model, error } = useSource( source );
	const view = useDeferredValue( model );
	const rows = useMemo(
		() => ( view ? table.rows( view ) : [] ),
		[ table, view ]
	);
	const context = useMemo(
		() => view && table.context( view ),
		[ table, view ]
	);
	if ( error ) {
		return <Unread error={ error } />;
	}
	return (
		<div className="nodes-probe-tab">
			<ProbeTable
				columns={ table.columns }
				rows={ rows }
				rowKey={ byKey }
				keyAttr={ table.keyAttr }
				context={ context }
				emptyText={ table.empty }
			/>
		</div>
	);
}

/**
 * @param {Object}                 props
 * @param {{source: string}}       props.attributes    The block's attributes.
 * @param {(next: Object) => void} props.setAttributes Writes them.
 * @param {Object<string,Object>}  props.schema        Each attribute's declared schema.
 * @return {import('react').ReactElement} The control.
 */
function Controls( { attributes, setAttributes, schema } ) {
	return (
		<SelectControl
			__next40pxDefaultSize
			__nextHasNoMarginBottom
			label={ __( 'Probe', 'newspack-nodes' ) }
			value={ attributes.source }
			options={ schema.source.enum.map( ( value ) => ( {
				value,
				label: TABLES[ value ].label,
			} ) ) }
			onChange={ ( next ) => setAttributes( { source: next } ) }
		/>
	);
}

export default { View, Controls };

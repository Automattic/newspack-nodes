/**
 * VerbStats — the Inspector's Stats section for a Table: the per-verb
 * counters `Table_Node::stats()` reports, carried as `verb_stats` in the
 * node's `dump_metadata` row, as a sortable grid. It re-renders with every
 * metadata poll, so the grid is as live as the rest of the Inspector.
 */

import { useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import {
	formatBytes,
	formatGroupedCount,
} from '@newspack-nodes/shared/utils/formatters';
import { formatDuration } from '@newspack-nodes/shared/utils/formatUtils';
import { Grid, sortRows, useSortState } from './SortableGrid';

/** The row key both grids lead with. */
const VERB = { key: 'name', label: 'VERB' };

/** The counts grid's columns; every one but VERB sorts numerically. */
const COUNT_COLS = [
	VERB,
	{ key: 'calls', label: 'CALLS', numeric: true, format: formatGroupedCount },
	{ key: 'asked', label: 'ASKED', numeric: true, format: formatGroupedCount },
	{
		key: 'answered',
		label: 'ANSWERED',
		numeric: true,
		format: formatGroupedCount,
	},
	{ key: 'bytes', label: 'BYTES', numeric: true, format: formatBytes },
];

/** The times grid's columns; every one but VERB sorts numerically. */
const TIME_COLS = [
	VERB,
	{ key: 'total_ms', label: 'TOTAL', numeric: true, format: formatDuration },
	{ key: 'avg_ms', label: 'AVG', numeric: true, format: formatDuration },
	{ key: 'max_ms', label: 'MAX', numeric: true, format: formatDuration },
];

/** Every column either grid holds, which the one shared sort orders by. */
const ALL_COLS = [ ...COUNT_COLS, ...TIME_COLS ];

/**
 * A Table's called verbs as two stacked grids, the counts then the times, so
 * each fits the rail. Both share one sort: the rows are ordered here, by any
 * column of either grid, and a grid given a column it lacks keeps that order,
 * so the verbs line up across the two. TOTAL descends until a header click in
 * either picks another order; a Table nothing has called shows one line.
 *
 * @param {Object}                                                         props
 * @param {Object<string,import('../../runtime/metadata-node').VerbStats>} props.stats The node's `verb_stats`.
 * @return {import('react').ReactElement} The Stats section body.
 */
export default function VerbStats( { stats } ) {
	const [ sort, onSort ] = useSortState( 'total_ms', 'desc' );
	const rows = useMemo(
		() =>
			sortRows(
				Object.entries( stats )
					.filter( ( [ , s ] ) => s.calls > 0 )
					.map( ( [ verb, s ] ) => ( {
						...s,
						name: verb,
						avg_ms: s.total_ms / s.calls,
					} ) ),
				ALL_COLS,
				sort
			),
		[ stats, sort ]
	);
	if ( 0 === rows.length ) {
		return (
			<span className="topology-edit-row__hint">
				{ __(
					'No calls since the Table was built or reset.',
					'newspack-nodes'
				) }
			</span>
		);
	}
	return (
		<>
			<Grid
				testid="verb-stats-counts"
				cols={ COUNT_COLS }
				rows={ rows }
				sort={ sort }
				onSort={ onSort }
			/>
			<Grid
				testid="verb-stats-times"
				cols={ TIME_COLS }
				rows={ rows }
				sort={ sort }
				onSort={ onSort }
			/>
		</>
	);
}

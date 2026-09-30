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
import { Grid, useSortState } from './SortableGrid';

/** The grid's columns; every one but VERB sorts numerically. */
const COLS = [
	{ key: 'name', label: 'VERB' },
	{ key: 'calls', label: 'CALLS', numeric: true, format: formatGroupedCount },
	{ key: 'asked', label: 'ASKED', numeric: true, format: formatGroupedCount },
	{
		key: 'answered',
		label: 'ANSWERED',
		numeric: true,
		format: formatGroupedCount,
	},
	{ key: 'bytes', label: 'BYTES', numeric: true, format: formatBytes },
	{ key: 'total_ms', label: 'TOTAL', numeric: true, format: formatDuration },
	{ key: 'avg_ms', label: 'AVG', numeric: true, format: formatDuration },
	{ key: 'max_ms', label: 'MAX', numeric: true, format: formatDuration },
];

/**
 * The grid of a Table's called verbs, TOTAL descending until a header click
 * picks another order; a Table nothing has called shows one line instead.
 *
 * @param {Object}                                                         props
 * @param {Object<string,import('../../runtime/metadata-node').VerbStats>} props.stats The node's `verb_stats`.
 * @return {import('react').ReactElement} The Stats section body.
 */
export default function VerbStats( { stats } ) {
	const [ sort, onSort ] = useSortState( 'total_ms', 'desc' );
	const rows = useMemo(
		() =>
			Object.entries( stats )
				.filter( ( [ , s ] ) => s.calls > 0 )
				.map( ( [ verb, s ] ) => ( {
					...s,
					name: verb,
					avg_ms: s.total_ms / s.calls,
				} ) ),
		[ stats ]
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
		<Grid
			testid="verb-stats-grid"
			cols={ COLS }
			rows={ rows }
			sort={ sort }
			onSort={ onSort }
		/>
	);
}

/**
 * One Topics panel: the shared `AreaTimeChart` over each topic's aligned
 * series, ranked by peak and coloured by rank.
 *
 * Nothing here knows which metric it draws, so one component serves the
 * Overview dashboard's four panels (message rate, byte rate, backlog, cache
 * size), the Jobs dashboard's four, the Tables tab's five (ops rate, operation
 * rate, miss rate, latency, size), and the debug overlay's two. The metric
 * arrives as data: the `series` to draw, each carrying the `mode` saying how a
 * bucket aggregates its samples and what an empty one holds, the `yLabel`
 * naming the quantity, and the `formatValue` its axis ticks and tooltip rows
 * print through. `topicChartSeries` builds the series on the dashboards,
 * `overviewChartSeries` in the overlay.
 *
 * `ProbeTable` beside it renders the probe tabs' per-identity tables from a
 * column declaration, so Jobs and Tables write out no table shell.
 *
 * `buildAlignedSeries` snaps every topic onto ONE epoch-aligned bucket grid
 * first, because each worker runs its own `Topic_Probe` on an independent 15s
 * phase and the raw union of their sample instants leaves each topic gapped at
 * every other topic's instant. The rank order that comes back indexes the
 * colours and the legend, and each rank's colour is the skin's own `--chart-*`
 * token (`chartColor`), so the panel re-skins with the page through CSS alone.
 */

import { memo, useCallback, useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { chartColor } from '@newspack-nodes/shared/hooks/useTimeChart';
import AreaTimeChart from '@newspack-nodes/shared/components/AreaTimeChart';
import { buildAlignedSeries } from './buildAlignedSeries';
import { formatGroupedCount } from '@newspack-nodes/shared/utils/formatters';

/** @typedef {import('@newspack-nodes/shared/utils/axis-ticks').AxisFormatter} AxisFormatter */

/** Total SVG height of one panel, in pixels, axis margins included. */
const HEIGHT = 200;

/**
 * Hard cap on the axis length `buildAlignedSeries` produces.
 *
 * A panel is about 1800px wide, so a denser axis is sub-pixel: the extra points
 * buy nothing but d3 redraw time.
 */
const MAX_POINTS = 1000;

/**
 * The colour a topic takes from its rank in the full list.
 *
 * @param {string} _label The topic; the rank alone decides.
 * @param {number} index  Its place in the ranking.
 * @return {string} A CSS colour value.
 */
const rankColor = ( _label, index ) => chartColor( index );

export const TopicsChart = memo(
	/**
	 * One Topics panel: ranked areas over a shared aligned time axis.
	 *
	 * The JSDoc rides this inner function because `memo()` on the const infers
	 * the props as `{}`. The `memo` keeps the redraw off unrelated renders: a
	 * panel rebuilds its whole SVG from scratch every time, while Overview
	 * re-renders on each poll tick, fold, expand and reorder. Callers hand over
	 * props stable across those renders — a memoized `series` and module-level
	 * formatters — so a panel whose own inputs did not move skips the draw
	 * entirely.
	 *
	 * @param {Object}        props             Component props.
	 * @param {string}        props.title       Panel heading, e.g. "Topics Message Rate".
	 * @param {string}        props.yLabel      Y-axis title naming the quantity, e.g. "Messages"; the ticks carry the unit.
	 * @param {?Object}       props.series      `{ [topic]: { points:[{ts,value,weight}], max, mode? } }` (ts in seconds); empty or absent wipes the panel.
	 * @param {AxisFormatter} props.formatValue Formats a value for the Y-axis ticks and the tooltip rows; a `tickValues` property on it ticks the axis in its own unit.
	 * @param {boolean}       [props.stacked]   Stack the series by default, for series that add up into a total; the corner toggle still flips it.
	 * @param {boolean}       [props.stackable] Offer the stack toggle; `false` for means, which never add up.
	 * @return {import('react').ReactElement} The rendered panel.
	 */
	function TopicsChart( {
		title,
		yLabel,
		series,
		formatValue,
		stacked = false,
		stackable = true,
	} ) {
		const chartState = useMemo(
			() => buildAlignedSeries( series, MAX_POINTS ),
			[ series ]
		);
		// One unit for the whole panel, whatever the peak.
		const yFormatFor = useCallback( () => formatValue, [ formatValue ] );

		return (
			<div className="newspack-nodes-card nodes-topics">
				<AreaTimeChart
					series={ chartState.series }
					yFormatFor={ yFormatFor }
					colorAt={ rankColor }
					title={ title }
					yLabel={ yLabel }
					height={ HEIGHT }
					stacked={ stacked }
					stackable={ stackable }
					totalLabel={ __( 'Total', 'newspack-nodes' ) }
				/>
			</div>
		);
	}
);

/**
 * A tab's Topics panels, one `TopicsChart` per declaration.
 *
 * A declaration is `{ title, yLabel, series, formatValue, stacked?,
 * stackable? }`. The array may be rebuilt per render, but each `series` must
 * stay a memoized object, or the chart's memo redraws.
 *
 * @param {Object}        props        Component props.
 * @param {Array<Object>} props.panels Panel declarations, drawn in order.
 * @return {import('react').ReactElement[]} One chart per declaration.
 */
export function TopicsPanels( { panels } ) {
	return panels.map( ( panel ) => (
		<TopicsChart key={ panel.title } { ...panel } />
	) );
}

/**
 * One column of a `ProbeTable`: its header, its cell, and optionally the
 * attributes its `<td>` takes.
 *
 * @typedef {Object} ProbeColumn
 * @property {string}                         label Header text, and the cell's React key.
 * @property {( row: *, ctx: * ) => *}        cell  The cell's content for one row.
 * @property {( row: * ) => Object<string,*>} [td]  Attributes for the cell's `<td>`.
 */

/**
 * A probe tab's per-identity table, or its empty state when no row is in.
 *
 * @param {Object}               props           Component props.
 * @param {Array<ProbeColumn>}   props.columns   The columns, in order.
 * @param {Array<Object>}        props.rows      The rows, already sorted.
 * @param {( row: * ) => string} props.rowKey    A row's identity.
 * @param {string}               props.keyAttr   The data attribute carrying that identity, e.g. `data-job-key`.
 * @param {*}                    [props.context] Handed to every cell beside its row.
 * @param {string}               props.emptyText What reads in place of a table with no rows.
 * @return {import('react').ReactElement} The table or the empty state.
 */
export function ProbeTable( {
	columns,
	rows,
	rowKey,
	keyAttr,
	context,
	emptyText,
} ) {
	if ( 0 === rows.length ) {
		return (
			<p className="newspack-nodes-empty-state nodes-probe-tab__empty">
				{ emptyText }
			</p>
		);
	}
	return (
		<table className="nodes-probe-tab__table newspack-nodes-table">
			<thead>
				<tr>
					{ columns.map( ( c ) => (
						<th key={ c.label }>{ c.label }</th>
					) ) }
				</tr>
			</thead>
			<tbody>
				{ rows.map( ( row ) => {
					const key = rowKey( row );
					return (
						<tr key={ key } { ...{ [ keyAttr ]: key } }>
							{ columns.map( ( c ) => (
								<td key={ c.label } { ...c.td?.( row ) }>
									{ c.cell( row, context ) }
								</td>
							) ) }
						</tr>
					);
				} ) }
			</tbody>
		</table>
	);
}

/**
 * The window's error count as a column, marked when it is not zero.
 *
 * @param {string} label The column header.
 * @return {ProbeColumn} The column, reading `row.windowed.errors`.
 */
export function errorsColumn( label ) {
	return {
		label,
		cell: ( row ) => formatGroupedCount( row.windowed.errors ),
		td: ( row ) => ( {
			className:
				row.windowed.errors > 0
					? 'nodes-probe-tab__count is-nonzero'
					: 'nodes-probe-tab__count',
		} ),
	};
}

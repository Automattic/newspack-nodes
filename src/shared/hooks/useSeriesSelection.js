/**
 * Which of a chart's series the reader asked to see.
 *
 * The state is a set of labels, and an empty set means every series: a chart
 * with nothing picked draws everything, which is where every chart starts. A
 * plain pick shows that series alone, a modified pick adds it to or removes it
 * from the set, and a plain pick of the only series already picked clears the
 * set, so the reader can back out the way they came.
 *
 * The set is kept as picked and read against the labels the chart carries
 * NOW: a series a poll or a breakdown switch retires drops out of the effective
 * set without being forgotten, so it is shown again if it returns, and a set
 * with nothing left in it reads as every series rather than as an empty chart.
 * A pick restates the whole intent, though: it builds on the effective set,
 * so a retired label never rides along and returns to the chart unasked.
 */

import { useCallback, useMemo, useState } from '@wordpress/element';

/**
 * @typedef  {Object} SeriesSelection
 * @property {Set<string>}                                  selected The labels picked that the chart still carries; empty means every series.
 * @property {( label: string, additive: boolean ) => void} onSelect Pick a label; `additive` is the modified click that toggles it in the set.
 * @property {( label: string ) => boolean}                 isShown  Whether a series is drawn: every one while nothing is picked.
 */

/**
 * Own a chart's series selection.
 *
 * @param {Array<string>} labels The labels the chart carries now, in draw order.
 * @return {SeriesSelection} The effective selection and the pick handler.
 */
export function useSeriesSelection( labels ) {
	const [ picked, setPicked ] = useState( () => new Set() );

	const selected = useMemo( () => {
		const carried = new Set( labels );
		return new Set( [ ...picked ].filter( ( l ) => carried.has( l ) ) );
	}, [ picked, labels ] );

	const onSelect = useCallback(
		( label, additive ) => {
			if ( additive ) {
				const next = new Set( selected );
				if ( next.has( label ) ) {
					next.delete( label );
				} else {
					next.add( label );
				}
				setPicked( next );
				return;
			}
			// The only picked one, picked again: back to every series.
			setPicked(
				1 === selected.size && selected.has( label )
					? new Set()
					: new Set( [ label ] )
			);
		},
		[ selected ]
	);

	const isShown = useCallback(
		( label ) => 0 === selected.size || selected.has( label ),
		[ selected ]
	);

	return { selected, onSelect, isShown };
}

/**
 * @typedef  {Object} Legend
 * @property {Array<{label: string, color: string}>}        legendItems One row per series in the full list, coloured by rank.
 * @property {Array<Object>}                                drawn       The series to draw: the picked ones, each carrying its `color`.
 * @property {Set<string>}                                  selected    The labels picked; empty means every series.
 * @property {( label: string, additive: boolean ) => void} onSelect    The pick handler `ChartLegend` calls.
 */

/**
 * Own a chart's legend and the series it leaves drawn.
 *
 * The colour follows the series' place in the FULL list, whatever is hidden,
 * so picking a neighbour recolours nothing; and it is stamped onto each drawn
 * series, so the areas and the swatches read one value.
 *
 * @param {Array<{label: string}>}                     series  Every series the chart carries, in draw order.
 * @param {( label: string, index: number ) => string} colorAt The colour for a series at its place in that list.
 * @return {Legend} The legend rows, the drawn series and the selection.
 */
export function useLegend( series, colorAt ) {
	const legendItems = useMemo(
		() =>
			series.map( ( s, i ) => ( {
				label: s.label,
				color: colorAt( s.label, i ),
			} ) ),
		[ series, colorAt ]
	);
	const labels = useMemo(
		() => legendItems.map( ( i ) => i.label ),
		[ legendItems ]
	);
	const { selected, onSelect, isShown } = useSeriesSelection( labels );
	const drawn = useMemo(
		() =>
			series
				.map( ( s, i ) => ( { ...s, color: legendItems[ i ].color } ) )
				.filter( ( s ) => isShown( s.label ) ),
		[ series, legendItems, isShown ]
	);
	return { legendItems, drawn, selected, onSelect };
}

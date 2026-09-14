/**
 * The legend beside a dashboard chart: one row per series, scrolling inside
 * the chart's height, each row a button that picks its series.
 *
 * HTML rather than an SVG group because a list that scrolls, wraps a long
 * label's title and takes a keyboard needs the browser's own controls; the
 * SVG column it replaces clipped every label past eighteen characters and
 * heard no click. The rows are native buttons under the shared
 * `.newspack-nodes-chart-legend` role — not `.button`s, which would paint them
 * as toolbar controls — so `aria-pressed` carries the pick for assistive
 * technology while the role paints it.
 *
 * The pick itself belongs to `useSeriesSelection`; this component only
 * reports which row was clicked and whether the click carried the modifier
 * that adds instead of replacing.
 */

/**
 * @param {Object}                                       props          Component props.
 * @param {Array<{label: string, color: string}>}        props.items    One row per series, in draw order.
 * @param {Set<string>}                                  props.selected The series picked; empty means every one is shown.
 * @param {( label: string, additive: boolean ) => void} props.onSelect Called with the clicked label and whether ctrl or cmd was held.
 * @param {number}                                       props.height   The chart's height in pixels, which bounds the list.
 * @return {import('react').ReactElement} The legend list.
 */
export default function ChartLegend( { items, selected, onSelect, height } ) {
	const dimming = selected.size > 0;
	return (
		<ul
			className="newspack-nodes-chart-legend"
			style={ { maxHeight: `${ height }px` } }
		>
			{ items.map( ( { label, color } ) => {
				const picked = selected.has( label );
				return (
					<li key={ label }>
						<button
							type="button"
							className={
								'newspack-nodes-chart-legend__item' +
								( dimming && ! picked ? ' is-dimmed' : '' )
							}
							aria-pressed={ picked }
							title={ label }
							onClick={ ( event ) =>
								onSelect(
									label,
									event.ctrlKey || event.metaKey
								)
							}
						>
							<span
								className="newspack-nodes-chart-legend__swatch"
								style={ { background: color } }
							/>
							<span className="newspack-nodes-chart-legend__label">
								{ label }
							</span>
						</button>
					</li>
				);
			} ) }
		</ul>
	);
}

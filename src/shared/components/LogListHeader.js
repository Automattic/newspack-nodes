/**
 * One column of a log-pane header.
 *
 * @typedef  {Object} LogHeaderColumn
 * @property {string} key         React key, unique within the column set.
 * @property {string} label       The visible, translated header text.
 * @property {string} [className] The row cell class carrying this column's width.
 * @property {string} [tooltip]   Hover text; omitted leaves the cell without a title.
 */

/**
 * LogListHeader — the column-header row capping a shared log pane.
 *
 * Every column reuses a row CELL class (`newspack-nodes-log-row__id` / `__key`
 * / `__value`, or a consumer's own), because the column widths live there:
 * header and cells then size from one declaration rather than two that drift.
 * The `styleOwnership` suite pins this as the only element carrying
 * `newspack-nodes-log-header`, so a consumer that wants a header composes this
 * one instead of hand-rolling markup.
 *
 * Render it as the sibling immediately preceding `LogRowList`, whose scroll
 * container is the `role="rowgroup"` half of the pair: an adjacent-sibling
 * rule paints the seam between the two, and `newspack-nodes-table` belongs to
 * that rowgroup alone. Rows are divs rather than table elements, so `role="row"`
 * and `role="columnheader"` carry the semantics the markup does not.
 *
 * @param {Object}            props         Props.
 * @param {LogHeaderColumn[]} props.columns The columns, in table order.
 * @return {import('react').ReactElement} The header row.
 */
export default function LogListHeader( { columns } ) {
	return (
		<div
			className="newspack-nodes-table__header newspack-nodes-log-header"
			role="row"
		>
			{ columns.map( ( column ) => (
				<span
					key={ column.key }
					role="columnheader"
					className={ `newspack-nodes-table__cell newspack-nodes-log-header__th ${
						column.className ?? ''
					}` }
					title={ column.tooltip }
				>
					{ column.label }
				</span>
			) ) }
		</div>
	);
}

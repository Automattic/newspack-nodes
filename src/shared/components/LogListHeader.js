/**
 * LogListHeader — the shared column-header row capping a log pane.
 *
 * Columns reuse the row cell classes (`newspack-nodes-log-row__id` / `__key` /
 * `__value`, or a consumer's own) so header and cells share one width source.
 *
 * @param {Object} props         Props.
 * @param {Array}  props.columns `{ key, label, className?, tooltip? }` per column.
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

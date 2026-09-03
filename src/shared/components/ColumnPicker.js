/**
 * The column chooser every table-shaped dashboard shares: the checkbox row a
 * "Cols" toolbar button reveals.
 *
 * @package
 */

/**
 * Render one checkbox per declared column, in declaration order.
 *
 * The row keeps no state. `useColumnPicker` owns the selection, persists it,
 * and re-adds a toggled-on column where `columns` declares it, so the checkbox
 * order and the table's column order are one list.
 *
 * @param {Object}                                        props            Props.
 * @param {Object<string,{label:string,tooltip?:string}>} props.columns    The canonical column map. Its entries also carry the `width` and `className` that lay the table out; the picker reads only `label` and `tooltip`.
 * @param {Function}                                      props.isVisible  Reports whether a column is drawn: `( key ) => boolean`.
 * @param {Function}                                      props.onToggle   Flips a column's visibility: `( key ) => void`.
 * @param {string}                                        [props.idPrefix] Prefix for the checkbox ids. Two pickers on one page would otherwise mint the same ids, and clicking one's label would toggle the other's box.
 * @return {import('react').ReactElement} The picker row.
 */
export default function ColumnPicker( {
	columns,
	isVisible,
	onToggle,
	idPrefix = 'col',
} ) {
	return (
		<div className="newspack-nodes-column-picker">
			{ Object.entries( columns ).map( ( [ key, col ] ) => (
				<label
					key={ key }
					htmlFor={ `${ idPrefix }-${ key }` }
					title={ col.tooltip }
				>
					<input
						id={ `${ idPrefix }-${ key }` }
						type="checkbox"
						checked={ isVisible( key ) }
						onChange={ () => onToggle( key ) }
					/>{ ' ' }
					{ col.label }
				</label>
			) ) }
		</div>
	);
}

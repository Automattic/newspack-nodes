/**
 * ColumnPicker — the checkbox row the "Cols" button reveals.
 *
 * @package
 */

/**
 * Render one checkbox per declared column.
 *
 * @param {Object}   props            Props.
 * @param {Object}   props.columns    Canonical map: key → `{ label, tooltip }`.
 * @param {Function} props.isVisible  `( key ) => boolean`.
 * @param {Function} props.onToggle   `( key ) => void`.
 * @param {string}   [props.idPrefix] Input id prefix; distinct per dashboard on a shared page.
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

/**
 * The stats block: a row of tiles, each one field of its source's model as a
 * big value over its declared label. `StatTile` and `StatTiles` are the one
 * tile and row every stat strip on a dashboard draws, the block's and a
 * page's own alike.
 *
 * A tile wears the shared card surface and the shared stat-tile role, and
 * its own class brings only geometry; `nodes-card--<id>` names a tile for a
 * page's stylesheet and its tests.
 */

import { fieldValue, shown, sourceBlock } from './sourceBlock';
import './stats.scss';

/**
 * One tile: a big value over a muted label.
 *
 * @param {Object}                    props
 * @param {string}                    props.id          Names the tile's `nodes-card--<id>` modifier.
 * @param {import('react').ReactNode} props.value       The value, already formatted.
 * @param {string}                    props.label       The caption beneath it.
 * @param {string}                    [props.className] A class beside the tile's own.
 * @return {import('react').ReactElement} The tile.
 */
export function StatTile( { id, value, label, className = '' } ) {
	return (
		<div
			className={ `newspack-nodes-card newspack-nodes-stat-tile nodes-card nodes-card--${ id } ${ className }`.trim() }
		>
			<span className="newspack-nodes-stat-value nodes-card__value">
				{ value }
			</span>
			<span className="newspack-nodes-stat-label nodes-card__label">
				{ label }
			</span>
		</div>
	);
}

/**
 * The row the tiles stand in, the shared stats grid: wrapping as they fit,
 * or a grid of `columns`.
 *
 * @param {Object}                    props
 * @param {number}                    [props.columns] Tiles per row; 0 wraps them as they fit.
 * @param {import('react').ReactNode} props.children  The tiles.
 * @return {import('react').ReactElement} The row.
 */
export function StatTiles( { columns = 0, children } ) {
	return (
		<div
			className={ `newspack-nodes-stats-grid nodes-cards${
				columns ? '' : ' is-flow'
			}` }
			style={
				columns
					? /** @type {import('react').CSSProperties} */ ( {
							'--newspack-nodes-stat-columns': columns,
					  } )
					: undefined
			}
		>
			{ children }
		</div>
	);
}

/**
 * The block: a tile per figure it names, every declared figure when it
 * names nothing, each wearing the modifier its field names for its value.
 *
 * @param {Object}                               props
 * @param {Object}                               props.attributes `{ source, fields, columns }`.
 * @param {Object}                               props.model      The source's model.
 * @param {import('./sourceBlock').BlockField[]} props.fields     The figures shown.
 * @return {import('react').ReactElement} The tiles.
 */
function Stats( { attributes, model, fields } ) {
	return (
		<StatTiles columns={ attributes.columns }>
			{ fields.map( ( field, place ) => {
				const value = fieldValue( field, model );
				return (
					<StatTile
						key={ `${ field.key }:${ place }` }
						id={ field.key }
						className={
							field.modifier
								? `nodes-card--${ field.modifier( value ) }`
								: ''
						}
						label={ field.label }
						value={ shown( field, value ) }
					/>
				);
			} ) }
		</StatTiles>
	);
}

export default sourceBlock( Stats, {
	kind: 'value',
	list: 'fields',
	settings: [ 'columns' ],
} );

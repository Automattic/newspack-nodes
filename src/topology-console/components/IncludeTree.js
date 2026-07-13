/**
 * IncludeTree — the authoritative include structure for the file being
 * edited.
 *
 * Top level = this file's directly-declared includes (removable); deeper
 * levels are read-only (open that file to act on its includes). Deletion
 * lives here, never on the canvas: "which include provides this node" is a
 * SET (a shared node has several providers), but "remove an include" is one
 * row — that's what sidesteps the diamond.
 */

import { __ } from '@wordpress/i18n';

function Branch( { name, subtree, depth, onRemove } ) {
	const kids = Object.keys( subtree || {} );
	return (
		<li className="topology-include-tree__item">
			<div className="topology-include-tree__row">
				<span className="topology-include-tree__name">{ name }</span>
				{ 0 === depth && onRemove && (
					<button
						type="button"
						className="topology-edit-verb__remove"
						data-testid={ `include-remove-${ name }` }
						aria-label={ `Remove include ${ name }` }
						onClick={ () => onRemove( name ) }
					>
						×
					</button>
				) }
			</div>
			{ kids.length > 0 && (
				<ul className="topology-include-tree__children">
					{ kids.map( ( k ) => (
						<Branch
							key={ k }
							name={ k }
							subtree={ subtree[ k ] }
							depth={ depth + 1 }
							onRemove={ null }
						/>
					) ) }
				</ul>
			) }
		</li>
	);
}

export default function IncludeTree( {
	tree = {},
	includes = [],
	selectedOrigin = null,
	onAdd,
	onRemove,
} ) {
	const roots = (
		selectedOrigin && selectedOrigin.length
			? includes.filter( ( n ) => selectedOrigin.includes( n ) )
			: includes
	).filter( ( n ) => Object.prototype.hasOwnProperty.call( tree, n ) );

	return (
		<div className="topology-include-tree">
			<h4 className="topology-insp__section-title">
				{ __( 'Includes', 'newspack-nodes' ) }
			</h4>
			<ul className="topology-include-tree__list">
				{ roots.map( ( name ) => (
					<Branch
						key={ name }
						name={ name }
						subtree={ tree[ name ] }
						depth={ 0 }
						onRemove={ onRemove }
					/>
				) ) }
			</ul>
			{ onAdd && (
				<button
					type="button"
					className="topology-edit-verb__add"
					onClick={ onAdd }
				>
					{ __( '+ add include', 'newspack-nodes' ) }
				</button>
			) }
		</div>
	);
}

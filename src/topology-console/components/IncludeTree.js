/**
 * IncludeTree — one topology file's include structure, as a nested list.
 *
 * A top-level row is an include the file declares itself, so it is one line to
 * remove; a deeper row belongs to another file's declaration and is read-only,
 * because acting on it means opening that file.
 *
 * Removing an include here is what sidesteps the diamond. "Which include
 * provides this node" is a SET, since a shared node has several providers,
 * while "remove this include" is one row — so this tree is how an include you
 * have NOT selected comes out. A selected hull is unambiguous already: its own
 * panel and the Delete key remove that one.
 *
 * The Inspector renders the edited file's includes with the remove control;
 * HullPanel reuses the same list read-only for a selected hull's own subtree.
 */

import { __ } from '@wordpress/i18n';

/**
 * One include row, and beneath it the includes that row brings in.
 *
 * The remove control appears on a root row only, and only when `onRemove` is
 * supplied: a deeper row's declaration lives in a file this tree is not
 * showing, so removing it would edit something off screen. The recursion says
 * that twice, passing both `depth + 1` and a null callback.
 *
 * @param {Object}                        props
 * @param {string}                        props.name       Topology this row stands for.
 * @param {Object}                        [props.subtree]  What `name` includes, `{ name: subtree }` recursively; empty renders a leaf.
 * @param {number}                        props.depth      0 for a declared include, deeper for one inherited through it.
 * @param {((name: string) => void)|null} [props.onRemove] Removes the declared include this row names. Null renders the row read-only.
 * @return {import('react').ReactElement} One list item, nesting a child list when the include has children.
 */
function Branch( { name, subtree, depth, onRemove } ) {
	const kids = Object.keys( subtree || {} );
	return (
		<li className="topology-include-tree__item">
			<div className="topology-include-tree__row">
				<span className="topology-include-tree__name">{ name }</span>
				{ 0 === depth && onRemove && (
					<button
						type="button"
						className="button button-small button-link-delete is-circle topology-edit-verb__remove"
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

/**
 * Renders the include tree as a nested list, one row per included topology.
 *
 * Roots are the intersection of `includes` and `tree`: a name the file
 * declares but the tree does not resolve has nothing to show, so it is
 * skipped. Only roots get a remove control, and only when `onRemove` is
 * supplied — a deeper row belongs to another file's declaration.
 *
 * @param {Object}                        props
 * @param {Object}                        [props.tree]     Nested include tree from `topologies expand`: `{ name: subtree }`, recursively. Default {}.
 * @param {string[]}                      [props.includes] The file's directly-declared includes, in declaration order; selects and orders the root rows. Default [].
 * @param {((name: string) => void)|null} [props.onRemove] Removes a declared include. Null or absent renders the tree read-only.
 * @return {import('react').ReactElement} The Includes section.
 */
export default function IncludeTree( { tree = {}, includes = [], onRemove } ) {
	const roots = includes.filter( ( n ) =>
		Object.prototype.hasOwnProperty.call( tree, n )
	);

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
		</div>
	);
}

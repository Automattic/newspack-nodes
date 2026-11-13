/**
 * A page's views map, whose one block reads its source by name.
 */

import { useSource } from '../../../../sources';

/**
 * A flock counted in its tree through a source.
 *
 * @param {Object} props
 * @param {Object} props.attributes Its attributes.
 * @return {import('react').ReactElement} The count.
 */
function Flock( { attributes } ) {
	const { model, loading } = useSource( 'hihi-7841', {
		tree: attributes.tree,
	} );
	return (
		<p data-testid="flock">
			{ loading
				? 'counting the flock'
				: `${ model.birds } birds in ${ attributes.tree }` }
		</p>
	);
}

export const HIHI_VIEWS = { 'hihi-7841/flock': { View: Flock } };

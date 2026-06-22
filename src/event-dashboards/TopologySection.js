/**
 * TopologySection — one topology's node/log tree. Header-less: the Topology
 * Manager card heading (its sole embedder) carries the per-partition summary,
 * ALL RUN / ALL DEAD badge, and fleet restart. The tree is rendered by
 * `TreeEntity` per root entity; fold state is owned by the caller via
 * `collapsed` + `onToggle`.
 */

import { memo } from '@wordpress/element';
import TreeEntity from './TreeEntity';

const TopologySection = memo( function TopologySection( props ) {
	const { section } = props;

	return section.tree.map( ( entity ) => (
		<TreeEntity
			key={ entity.key }
			{ ...props }
			entity={ entity }
			depth={ 0 }
		/>
	) );
} );

export default TopologySection;

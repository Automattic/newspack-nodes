/**
 * TopologySection — one topology's node/log tree. Header-less: the Topology
 * Manager card heading (its sole embedder) carries the per-partition summary,
 * ALL RUN / ALL DEAD badge, and fleet restart. The tree is rendered by
 * `TreeEntity` per root entity; fold state is owned by the caller via
 * `collapsed` + `onToggle`.
 */

import { memo } from '@wordpress/element';
import TreeEntity from './TreeEntity';

const TopologySection = memo(
	/**
	 * Renders one `TreeEntity` per root entity. Every prop is threaded straight
	 * through to the tree, so this component reads only `section.tree`.
	 *
	 * @param {Object}   props                  Component props.
	 * @param {Object}   props.section          One `buildTopologySections` section; `tree` holds its root entities.
	 * @param {Array}    props.workers          The section's worker descriptors.
	 * @param {Object}   props.byteRates        Read bytes/sec, keyed `handler-partition-source`.
	 * @param {Object}   props.writeRates       Write bytes/sec, keyed by concrete log name.
	 * @param {number}   props.segmentSize      Segment size in bytes for logs that declare none.
	 * @param {number}   props.currentTime      Snapshot timestamp, unix seconds.
	 * @param {Object}   props.prevSegments     Prior snapshot's segment ids per log name (a `Set` each), which flags the new ones.
	 * @param {Object}   props.removingSegments Segments gone since the prior snapshot, per log name, held for the exit animation.
	 * @param {Set}      props.collapsed        Keys of the folded entities; fold state is owned by the caller.
	 * @param {Function} props.onToggle         (key) => void; fold or unfold one entity.
	 * @return {Array<import('react').ReactElement>} One subtree per root entity.
	 */
	function TopologySection( props ) {
		const { section } = props;

		return section.tree.map( ( entity ) => (
			<TreeEntity
				key={ entity.key }
				{ ...props }
				entity={ entity }
				depth={ 0 }
			/>
		) );
	}
);

export default TopologySection;

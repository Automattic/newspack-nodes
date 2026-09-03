/**
 * TopologySection — one topology's live node/log tree, drawn as one
 * `TreeEntity` per root entity of a `topologyGraph.buildTopologySections`
 * section.
 *
 * It renders no heading of its own. `TopologyRow`, its only embedder, already
 * heads the card with the topology name, the per-partition pills, the ALL RUN
 * / ALL DEAD badge and the activate/restart/edit controls, so a heading here
 * would say all of it twice.
 *
 * Fold state stays with the caller, as `collapsed` + `onToggle`. Overview owns
 * that Set and persists it through `overviewPrefs`, so a fold survives a
 * reload; state held here would reset with the component.
 */

import { memo } from '@wordpress/element';
import TreeEntity from './TreeEntity';

const TopologySection = memo(
	/**
	 * Renders one `TreeEntity` per root entity, spreading every prop into each,
	 * so one call paints a whole subtree. `section.tree` is all this component
	 * reads; the rest of the props are the tree's.
	 *
	 * @param {Object}                       props                  Component props.
	 * @param {Object}                       props.section          One `buildTopologySections` section; its `tree` holds the root entities.
	 * @param {Array<Object>}                props.workers          The section's worker descriptors. No entity in the tree reads the list — a `node` entity carries its own rows.
	 * @param {Object<string,number>}        props.writeRates       Write bytes per second, keyed by concrete partition name (`firehose.p0`).
	 * @param {number}                       props.segmentSize      Fleet-wide segment size in bytes, scaling the bars of a log that declares none of its own.
	 * @param {number}                       props.currentTime      Snapshot timestamp, unix seconds. No entity in the tree reads it.
	 * @param {Object<string,Set<number>>}   props.prevSegments     The prior snapshot's segment ids per partition name; a segment missing from it animates in.
	 * @param {Object<string,Array<Object>>} props.removingSegments Segments gone since the prior snapshot, per partition name, drawn until they finish animating out.
	 * @param {Set<string>}                  props.collapsed        Keys of the folded entities, owned by the caller.
	 * @param {(key: string) => void}        props.onToggle         Called with an entity key to fold or unfold it.
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

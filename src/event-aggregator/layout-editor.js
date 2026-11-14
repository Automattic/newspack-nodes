/**
 * The Aggregator layout editor's bundle, which `Station_Pages::enqueue()`
 * loads on an edit load for a `tune` caller alone: the localized context's
 * blocks against this bundle's views, whose module declares the sources and
 * the page state the blocks read.
 */

import { BLOCK_VIEWS } from './aggregatorSources';
import { mountStationEditor } from '../station/stationEditor';

mountStationEditor(
	/** @type {{NewspackNodesComposition: import('@newspack-nodes/shared/composition/page/mountComposedEditor').LocalizedComposition}} */ (
		/** @type {unknown} */ ( window )
	).NewspackNodesComposition,
	BLOCK_VIEWS
);

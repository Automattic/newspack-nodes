/**
 * The Path menu's live topology catalog: which topologies exist, how many
 * partitions each runs, and which of them the fleet spawns.
 *
 * The hook OWNS its node rather than borrowing one from `useConsoleGraph`, and
 * that ownership is load-bearing. What it returns builds the console's
 * `pathOptions`, which builds the `workers` list, whose join is the console
 * graph effect's `workersKey` dependency. A catalog node mounted by that effect
 * would therefore be torn down by the very publish it had just made, rebuilt
 * carrying the frozen page-load seed its constructor holds, and the console
 * would swing between seed and live at the poll cadence, reconnecting SSE each
 * time.
 *
 * Owning it also keeps the catalog polling in edit mode, where the console
 * graph is disabled — and edit mode is where save and delete call `reload()`.
 *
 * It mounts the node as an exospine PASSENGER, the way the console's other
 * catalogs and one-shots mount theirs. TopologyConsole declares this hook
 * before `useConsoleGraph`, so its mount runs first; a passenger never owns the
 * backbone, so the console keeps Reset Graph, and the mount re-attaches the
 * node whenever the console replaces the backbone under it. The rebuilt node
 * starts from the catalog its predecessor last published, never the seed.
 *
 * The node sends `topologies dump` under the `topologies` group, to
 * `topologies:shell/_http/topologies`. Its mount claims the `topologies:shell`
 * Tap from that target, so `connect topologies:shell` watches the catalog poll
 * beside every other topology read and write the console sends.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from '@wordpress/element';
import { egressPath } from '@newspack-nodes/shared/helpers/egressPath';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeField } from '../../runtime/react';
import { TOPOLOGIES_CI } from './useCatalogs';
import {
	CATALOG_NODE,
	TopologyCatalogNode,
	seedFromGlobal,
} from '../nodes/topology-catalog-node';

/**
 * Poll cadence in milliseconds. At 1000 or more the node hitchhikes the
 * `_router` TIMER instead of taking a `setInterval` slot of its own, and rides
 * the shared wall-clock grid (ADR-17), so this poll meets the console's 1s
 * pollers on every tenth tick and leaves in their one batched POST.
 */
const POLL_INTERVAL_MS = 10000;

/**
 * Mount the catalog node and read what it publishes.
 *
 * Before the first reply lands the returned values are the page-load seed the
 * PHP localizer wrote, so the Path menu is never empty.
 *
 * @return {{partitions: Object<string,number>, active: string[], entries: Object[], reload: () => void}}
 *   `partitions` maps each topology name to its partition count; `active` lists
 *   the topologies the fleet spawns; `entries` are the raw `topologies dump`
 *   entries the palette and the include hulls read `includes` from; `reload`
 *   polls immediately rather than waiting out the cadence, which is what save,
 *   delete and activate each call.
 */
export function useTopologyCatalog() {
	// @longform
	// One identity for the pre-node seed so the caller's useMemo can rest on
	// it; read at first render, not at import — the localizer writes the global
	// before the bundle runs, but a module-scope read cannot be tested.
	const seed = useMemo( seedFromGlobal, [] );
	const catalog = useNodeField( CATALOG_NODE, 'catalog' ) ?? seed;
	// What a rebuild hands its fresh node, so nothing swings back to the seed.
	const catalogRef = useRef( catalog );
	catalogRef.current = catalog;

	// Bumped after each build, so `useNodeField` rebinds to the new node.
	const [ , bumpBuild ] = useState( 0 );
	useEffect( () => {
		const { teardown } = mountExospine(
			( { interpreter } ) => {
				const node = new TopologyCatalogNode();
				node.name = CATALOG_NODE;
				// A rebuilt node keeps the catalog, not the page-load seed.
				node.catalog = catalogRef.current;
				node.sink = interpreter;
				// The reply comes back TO=FROM to this node (ADR-7).
				node.target = egressPath( TOPOLOGIES_CI, TOPOLOGIES_CI );
				node.setTimer( POLL_INTERVAL_MS );
				bumpBuild( ( n ) => n + 1 );
			},
			{ passenger: true }
		);
		return teardown;
	}, [] );

	const reload = useCallback( () => Core.node( CATALOG_NODE )?.fire(), [] );

	return {
		partitions: catalog.partitions,
		active: catalog.active,
		entries: catalog.entries || [],
		reload,
	};
}

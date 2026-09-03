/**
 * The Path menu's live topology catalog: which topologies exist, how many
 * partitions each runs, and which of them the fleet spawns.
 *
 * The hook OWNS its node rather than borrowing one from `useConsoleGraph`, and
 * that ownership is load-bearing. What it returns builds the console's
 * `pathOptions`, which builds the `workers` list, whose join is the console
 * graph effect's `workersKey` dependency. A catalog node mounted by that effect
 * would therefore be torn down by the very publish it had just made, rebuilt
 * carrying the frozen page-load seed its constructor publishes, and the console
 * would swing between seed and live at the poll cadence, reconnecting SSE each
 * time.
 *
 * Owning it also keeps the catalog polling in edit mode, where the console
 * graph is disabled — and edit mode is where save and delete call `reload()`.
 *
 * A passenger, like `useRouterTick`: it attaches to a backbone another mount
 * owns and re-attaches whenever one comes up, rather than raising its own.
 */

import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { Core } from '../../runtime/core';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';
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
 *   the topologies the fleet spawns; `entries` are the raw `topologies list`
 *   entries the palette and the include hulls read `includes` from; `reload`
 *   polls immediately rather than waiting out the cadence, which is what save,
 *   delete and activate each call.
 */
export function useTopologyCatalog() {
	// A rebuild bumps the generation; a bare mount only raises the backbone.
	const [ attachEpoch, setAttachEpoch ] = useState( 0 );
	useEffect( () => {
		const bump = () => setAttachEpoch( ( n ) => n + 1 );
		const offGeneration = Core.subscribeGraphGeneration( bump );
		const offBackbone = Core.subscribeBackboneUp( bump );
		return () => {
			offGeneration();
			offBackbone();
		};
	}, [] );

	useEffect( () => {
		const interpreter = Core.node( names.COMMAND_INTERPRETER );
		// No graph yet, or mid-rebuild; the epoch bump retries.
		if ( ! interpreter || Core.node( CATALOG_NODE ) ) {
			return undefined;
		}
		const node = new TopologyCatalogNode();
		node.name = CATALOG_NODE;
		node.sink = interpreter;
		// Router peels `_http`; the reply comes back TO=FROM here (ADR-7).
		node.target = `${ names.HTTP }/topologies`;
		node.setTimer( POLL_INTERVAL_MS );
		return () => node.removeNode();
	}, [ attachEpoch ] );

	// @longform
	// One identity for the pre-node seed so the caller's useMemo can rest on
	// it; read at first render, not at import — the localizer writes the global
	// before the bundle runs, but a module-scope read cannot be tested.
	const seed = useMemo( seedFromGlobal, [] );
	const catalog = useNodeState( CATALOG_NODE, 'catalog' ) ?? seed;
	const reload = useCallback( () => Core.node( CATALOG_NODE )?.fire(), [] );

	return {
		partitions: catalog.partitions,
		active: catalog.active,
		entries: catalog.entries || [],
		reload,
	};
}

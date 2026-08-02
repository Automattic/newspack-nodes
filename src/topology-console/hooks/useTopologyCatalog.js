/**
 * useTopologyCatalog — the Path menu's live topology catalog.
 *
 * It OWNS its node rather than borrowing one from useConsoleGraph, and that is
 * load-bearing. The catalog feeds `pathOptions` → `workers` → `workersKey`,
 * which is a dependency of the console graph's effect — so a node mounted by
 * that effect is destroyed by the very publish it just made, re-seeded from the
 * frozen page-load snapshot on reconstruction, and the console oscillates
 * between seed and live at the poll rate, reconnecting SSE each time.
 *
 * Owning it also keeps the catalog alive in edit mode, where the console graph
 * is disabled — which is exactly when `reload()` is called, on save and delete.
 *
 * A passenger, like useRouterTick: it attaches to a backbone someone else owns
 * and re-attaches when one appears.
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

// Poll cadence; >1000 so the Router hitchhike throttles rather than every tick.
const POLL_INTERVAL_MS = 10000;

export { CATALOG_NODE };

export function useTopologyCatalog() {
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
		// Router peels `_http`; the reply returns TO=FROM to this node.
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

/**
 * useTopologyCatalog — the LIVE source of the Path menu's topology partition
 * counts + active set. The page-load `NewspackNodesData` snapshot is only
 * correct until something changes the registry: an in-console save/delete, or
 * an external `wp nodes restart` / supervisor spawn. So this hook SEEDS from
 * that snapshot (correct first paint, no fetch flash) and then refreshes from
 * `topologies.list` on mount + an interval (external changes), pausing while
 * the tab is hidden. `reload()` forces an immediate refresh after an in-console
 * mutation. A failed refetch keeps the last-good catalog — the menu never blanks.
 *
 * Returns `{ partitions: { name: num_partitions }, active: [ name… ], reload }`.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';
import usePageVisibility from '../../shared/hooks/usePageVisibility';

const POLL_INTERVAL_MS = 10000;

// The page-load snapshot the PHP localizer wrote — the seed before any fetch.
function seedFromGlobal() {
	const data =
		( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
	return {
		partitions: data.topologyPartitions || {},
		active: data.activeTopologies || [],
	};
}

// Map a `topologies.list` entry array to the catalog shape. `num_partitions` is
// authoritative (the handler derives it the same way the localizer does);
// configNumPartitions is the defensive fallback for a malformed entry.
function catalogFromList( list, defaultPartitions ) {
	const partitions = {};
	const active = [];
	for ( const entry of list ) {
		partitions[ entry.name ] = entry.num_partitions || defaultPartitions;
		if ( entry.active ) {
			active.push( entry.name );
		}
	}
	return { partitions, active };
}

export function useTopologyCatalog( { pollMs = POLL_INTERVAL_MS } = {} ) {
	const [ data, setData ] = useState( seedFromGlobal );
	const [ reloadKey, setReloadKey ] = useState( 0 );
	const reload = useCallback( () => setReloadKey( ( k ) => k + 1 ), [] );
	const isVisible = usePageVisibility();

	// Signature of the last applied catalog — an identical poll result skips
	// setState so consumers (pathOptions, the status-line effect) don't churn
	// every tick on unchanged data. Primed to the seed on first render so a
	// first fetch that matches the snapshot doesn't force a needless re-render.
	const lastSig = useRef( null );
	if ( null === lastSig.current ) {
		lastSig.current = JSON.stringify( data );
	}

	useEffect( () => {
		if ( ! isVisible ) {
			return undefined;
		}
		let cancelled = false;
		const defaultPartitions =
			( window.NewspackNodesData &&
				window.NewspackNodesData.configNumPartitions ) ||
			1;
		const fetchOnce = () => {
			getCommandClient()
				.send( { to: 'topologies', verb: 'list' } )
				.then( ( message ) => {
					if ( cancelled ) {
						return;
					}
					const body = unwrapCommandResponse( message );
					// Only a well-formed list ever replaces the catalog: a legit
					// empty `[]` collapses the menu, but a malformed reply (no
					// `topologies` array) keeps the last-good — never blanks.
					if ( ! body || ! Array.isArray( body.topologies ) ) {
						return;
					}
					const next = catalogFromList(
						body.topologies,
						defaultPartitions
					);
					const sig = JSON.stringify( next );
					if ( sig !== lastSig.current ) {
						lastSig.current = sig;
						setData( next );
					}
				} )
				.catch( () => {
					// Keep the last-good catalog; a transient list failure must
					// not blank the Path menu.
				} );
		};
		fetchOnce();
		const id = setInterval( fetchOnce, pollMs );
		return () => {
			cancelled = true;
			clearInterval( id );
		};
	}, [ reloadKey, pollMs, isVisible ] );

	return { partitions: data.partitions, active: data.active, reload };
}

/**
 * useExpandedIncludes — the composed baseline for the draft's include set.
 *
 * One `topologies expand` round trip per include-set change (none at all when
 * the set is empty). A cycle/conflict/unknown-name throws server-side; we keep
 * the last-good baseline and surface the message so the caller can revert.
 *
 * A module-level cache (keyed by the joined include string) is shared with
 * TopologyConsole's `fetchIncludeBaseline` — its synchronous open-path fetch
 * primes this cache, so the reactive pass below is a cache hit instead of a
 * second identical round trip.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

const EMPTY = { nodes: [], edges: [], tree: {} };

const cache = new Map();

export function getExpandedIncludesCache( key ) {
	return cache.get( key );
}

export function setExpandedIncludesCache( key, baseline ) {
	cache.set( key, baseline );
}

/**
 * Drop every cached expansion. Saving or deleting ANY topology can change what
 * an `include` of it expands to, so the console invalidates on both.
 */
export function invalidateExpandedIncludes() {
	cache.clear();
}

/**
 * Test-only reset — the cache is module-level and otherwise persists across
 * `it` blocks in the same test file.
 */
export function __resetExpandedIncludesCacheForTests() {
	cache.clear();
}

export function useExpandedIncludes( includes ) {
	const key = ( includes || [] ).join( ' ' );
	const [ state, setState ] = useState( {
		baseline: EMPTY,
		error: null,
		loading: false,
	} );
	const lastKey = useRef( null );

	useEffect( () => {
		if ( '' === key ) {
			lastKey.current = key;
			setState( { baseline: EMPTY, error: null, loading: false } );
			return undefined;
		}
		if ( lastKey.current === key ) {
			return undefined;
		}
		const cached = cache.get( key );
		if ( cached ) {
			lastKey.current = key;
			setState( { baseline: cached, error: null, loading: false } );
			return undefined;
		}
		lastKey.current = key;
		let cancelled = false;
		setState( ( s ) => ( { ...s, loading: true, error: null } ) );
		getCommandClient()
			.send( { to: 'topologies', verb: 'expand', args: key } )
			.then( ( message ) => {
				if ( cancelled ) {
					return;
				}
				const value = unwrapCommandResponse( message );
				const baseline = {
					nodes: value.nodes || [],
					edges: value.edges || [],
					tree: value.tree || {},
				};
				cache.set( key, baseline );
				setState( { baseline, error: null, loading: false } );
			} )
			.catch( ( e ) => {
				if ( cancelled ) {
					return;
				}
				setState( ( s ) => ( {
					baseline: s.baseline,
					error: e?.message || 'expand failed',
					loading: false,
				} ) );
			} );
		return () => {
			cancelled = true;
		};
	}, [ key ] );

	return state;
}

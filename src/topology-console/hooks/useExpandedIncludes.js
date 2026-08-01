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

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import { formatCommandArgs } from '../../runtime/command-args';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

const EMPTY = { nodes: [], edges: [], tree: {}, hulls: {} };

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

/**
 * One-off `topologies expand` round trip for a topology-open/edit-entry load
 * (applyLoadedBaseline needs the composed baseline BEFORE the draft is set,
 * so it can subtract `disconnects`; useExpandedIncludes only reacts AFTER).
 *
 * Shares useExpandedIncludes' module-level cache: a cache hit here skips the
 * network round trip, and a fresh fetch primes the cache so the reactive
 * useExpandedIncludes pass that follows (once the includes land in the
 * draft) is itself a cache hit — one `topologies expand` per open, not two.
 *
 * @param {string[]} includes Directly-declared includes to expand.
 * @return {Promise<Object>} `{ nodes, edges, tree }`.
 */
/**
 * Seed the cache with an expansion that arrived some other way (`topologies get`
 * ships one with the file), so the reactive pass below is a cache hit.
 *
 * @param {string[]} includes Directly-declared includes the expansion covers.
 * @param {Object}   baseline `{ nodes, edges, tree }`.
 */
export function primeExpandedIncludes( includes, baseline ) {
	if ( ! includes || ! includes.length || ! baseline ) {
		return;
	}
	cache.set( includes.join( ' ' ), {
		nodes: baseline.nodes || [],
		edges: baseline.edges || [],
		tree: baseline.tree || {},
		hulls: baseline.hulls || {},
	} );
}

export async function fetchExpandedIncludes( includes ) {
	if ( ! includes || ! includes.length ) {
		return EMPTY;
	}
	const key = includes.join( ' ' );
	const cached = cache.get( key );
	if ( cached ) {
		return cached;
	}
	const message = await getCommandClient().send( {
		to: 'topologies',
		verb: 'expand',
		args: formatCommandArgs( includes ),
	} );
	const value = unwrapCommandResponse( message ) || {};
	const baseline = {
		nodes: value.nodes || [],
		edges: value.edges || [],
		tree: value.tree || {},
		hulls: value.hulls || {},
	};
	cache.set( key, baseline );
	return baseline;
}

export function useExpandedIncludes( includes ) {
	const key = ( includes || [] ).join( ' ' );
	// Latest includes for the effect (it depends on the stable key).
	const includesRef = useRef( includes );
	includesRef.current = includes;
	const [ state, setState ] = useState( {
		baseline: EMPTY,
		error: null,
		loading: false,
	} );

	// @longform
	// The lastKey latch was set BEFORE the request, so one failed expansion
	// was permanent for that key — the baseline stayed missing until the key
	// changed. The loop owns whether another attempt is due; the cache still
	// serves an already-expanded key, so only an unresolved one is retried.
	const load = useCallback( async () => {
		const cached = cache.get( key );
		if ( cached ) {
			setState( ( s ) =>
				cached === s.baseline && ! s.error && ! s.loading
					? s
					: { baseline: cached, error: null, loading: false }
			);
			return;
		}
		setState( ( s ) => ( { ...s, loading: true, error: null } ) );
		try {
			const message = await getCommandClient().send( {
				to: 'topologies',
				verb: 'expand',
				args: formatCommandArgs( includesRef.current || [] ),
			} );
			const value = unwrapCommandResponse( message );
			const baseline = {
				nodes: value.nodes || [],
				edges: value.edges || [],
				tree: value.tree || {},
				hulls: value.hulls || {},
			};
			cache.set( key, baseline );
			setState( { baseline, error: null, loading: false } );
		} catch ( e ) {
			setState( ( s ) => ( {
				baseline: s.baseline,
				error: e?.message || 'expand failed',
				loading: false,
			} ) );
			throw e;
		}
	}, [ key ] );

	// An empty include set resets synchronously, as it always did.
	useEffect( () => {
		if ( '' === key ) {
			setState( { baseline: EMPTY, error: null, loading: false } );
		}
	}, [ key ] );

	useReconcile( { load, enabled: '' !== key, deps: [ key ] } );

	return state;
}

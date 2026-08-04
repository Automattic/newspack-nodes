/**
 * useExpandedIncludes — the composed expansion for the draft's include set.
 *
 * One `topologies expand` round trip per include-set change (none at all when
 * the set is empty). A cycle/conflict/unknown-name throws server-side; we keep
 * the last-good expansion and surface the message so the caller can revert.
 *
 * A module-level cache (keyed by the joined include string) is shared with
 * TopologyConsole's `fetchIncludeBaseline` — its synchronous open-path fetch
 * primes this cache, so the reactive pass below is a cache hit instead of a
 * second identical round trip.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import { formatCommandArgs } from '../../runtime/command-args';
import useRequestNode, {
	requestVia,
} from '@newspack-nodes/shared/hooks/useRequestNode';

const EMPTY = { nodes: [], edges: [], tree: {}, hulls: {} };

// Mounted below; the module-level fetch borrows it, queueing behind it.
const EXPAND_NODE = 'topologies:expand';

const cache = new Map();

/**
 * Drop every cached expansion. Saving or deleting ANY topology can change what
 * an `include` of it expands to, so the console invalidates on both.
 */
export function invalidateExpandedIncludes() {
	cache.clear();
}

/**
 * Seed the cache with an expansion that arrived some other way (`topologies get`
 * ships one with the file), so the reactive pass below is a cache hit.
 *
 * @param {string[]} includes  Directly-declared includes the expansion covers.
 * @param {Object}   expansion `{ nodes, edges, tree, hulls }`.
 */
export function primeExpandedIncludes( includes, expansion ) {
	if ( ! includes || ! includes.length || ! expansion ) {
		return;
	}
	cache.set( includes.join( ' ' ), {
		nodes: expansion.nodes || [],
		edges: expansion.edges || [],
		tree: expansion.tree || {},
		hulls: expansion.hulls || {},
	} );
}

/**
 * One-off `topologies expand` round trip for a topology-open/edit-entry load
 * (applyLoadedBaseline needs the composed expansion BEFORE the draft is set,
 * so it can subtract `disconnects`; useExpandedIncludes only reacts AFTER).
 *
 * Shares useExpandedIncludes' module-level cache: a cache hit here skips the
 * network round trip, and a fresh fetch primes the cache so the reactive
 * useExpandedIncludes pass that follows (once the includes land in the
 * draft) is itself a cache hit — one `topologies expand` per open, not two.
 *
 * @param {string[]} includes Directly-declared includes to expand.
 * @return {Promise<Object>} `{ nodes, edges, tree, hulls }`; empty when
 *                           `includes` is empty.
 */
export async function fetchExpandedIncludes( includes ) {
	if ( ! includes || ! includes.length ) {
		return EMPTY;
	}
	const key = includes.join( ' ' );
	const cached = cache.get( key );
	if ( cached ) {
		return cached;
	}
	const value =
		( await requestVia(
			EXPAND_NODE,
			'expand',
			formatCommandArgs( includes )
		) ) || {};
	const expansion = {
		nodes: value.nodes || [],
		edges: value.edges || [],
		tree: value.tree || {},
		hulls: value.hulls || {},
	};
	cache.set( key, expansion );
	return expansion;
}

/**
 * Track the composed expansion of the draft's include set, reactively.
 *
 * The include set is held as desired state (`useReconcile`), not fetched once:
 * an expansion that failed — a refused command session, a restarted worker —
 * keeps being retried until it resolves, while an already-expanded set is
 * served from the module cache instead of re-requested. An empty set resets to
 * the empty expansion synchronously, with no round trip at all.
 *
 * A server-side cycle, conflict, or unknown include name throws; the last-good
 * expansion is kept and `error` carries the message, so the caller can revert
 * the include that broke it.
 *
 * @param {string[]} includes The draft's directly-declared includes.
 * @return {{expansion: Object, error: string|null, loading: boolean}} The
 *         composed `{ nodes, edges, tree, hulls }`, the last failure message,
 *         and whether a round trip is in flight.
 */
export function useExpandedIncludes( includes ) {
	const key = ( includes || [] ).join( ' ' );
	// Latest includes for the effect (it depends on the stable key).
	const includesRef = useRef( includes );
	includesRef.current = includes;
	const [ state, setState ] = useState( {
		expansion: EMPTY,
		error: null,
		loading: false,
	} );
	const request = useRequestNode( EXPAND_NODE, 'topologies' );

	// @longform
	// The lastKey latch was set BEFORE the request, so one failed expansion
	// was permanent for that key — the expansion stayed missing until the key
	// changed. The loop owns whether another attempt is due; the cache still
	// serves an already-expanded key, so only an unresolved one is retried.
	const load = useCallback( async () => {
		const cached = cache.get( key );
		if ( cached ) {
			setState( ( s ) =>
				cached === s.expansion && ! s.error && ! s.loading
					? s
					: { expansion: cached, error: null, loading: false }
			);
			return;
		}
		setState( ( s ) => ( { ...s, loading: true, error: null } ) );
		try {
			const value = await request(
				'expand',
				formatCommandArgs( includesRef.current || [] )
			);
			const expansion = {
				nodes: value.nodes || [],
				edges: value.edges || [],
				tree: value.tree || {},
				hulls: value.hulls || {},
			};
			cache.set( key, expansion );
			setState( { expansion, error: null, loading: false } );
		} catch ( e ) {
			setState( ( s ) => ( {
				expansion: s.expansion,
				error: e?.message || 'expand failed',
				loading: false,
			} ) );
			throw e;
		}
	}, [ key, request ] );

	// An empty include set resets synchronously, as it always did.
	useEffect( () => {
		if ( '' === key ) {
			setState( { expansion: EMPTY, error: null, loading: false } );
		}
	}, [ key ] );

	useReconcile( { load, enabled: '' !== key, deps: [ key ] } );

	return state;
}

/**
 * Whether an expansion belongs to the document currently loaded.
 *
 * `topologies expand` keys its `tree` by the direct includes that resolved, so
 * the top-level keys are exactly what was asked for. Opening a child topology
 * leaves the PARENT's expansion in state for a tick, and re-seeding from it
 * marks the child's own nodes borrowed — after which the document stops
 * declaring them and a save writes an empty file.
 *
 * @param {Object} expansion `topologies expand` result.
 * @param {Array}  includes  The document's direct includes.
 * @return {boolean} True when the expansion is this document's.
 */
export function expansionMatchesIncludes( expansion, includes ) {
	const tree = expansion?.tree ?? {};
	const declared = includes ?? [];
	return (
		Object.keys( tree ).length === declared.length &&
		declared.every( ( name ) => name in tree )
	);
}

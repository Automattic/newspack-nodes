/**
 * useExpandedIncludes — the composed expansion for the draft's include set.
 *
 * One `topologies expand` round trip per include-set change (none at all when
 * the set is empty). A cycle/conflict/unknown-name throws server-side; we keep
 * the last-good expansion and surface the message so the caller can revert.
 *
 * A module-level cache, keyed by the joined include string. `topologies get`
 * ships the expansion with the file, so an OPEN primes this cache and the
 * reactive pass below is a hit rather than a second identical round trip.
 */

import { useEffect, useState } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

const EMPTY = { nodes: [], edges: [], tree: {}, hulls: {} };

const cache = new Map();

/**
 * Shape a raw `topologies expand` reply, which may be missing any of its lists.
 *
 * @param {?Object} value The reply payload.
 * @return {Object} `{ nodes, edges, tree, hulls }`.
 */
function shape( value ) {
	return {
		nodes: value?.nodes || [],
		edges: value?.edges || [],
		tree: value?.tree || {},
		hulls: value?.hulls || {},
	};
}

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
	cache.set( includes.join( ' ' ), shape( expansion ) );
}

/**
 * Track the composed expansion of an include set, reactively.
 *
 * The ask is a READ, so it keeps asking until an answer lands: an expansion
 * lost to a refused session or a restarted worker resolves on its own, and a
 * new include set SUPERSEDES the old one rather than queueing behind it. An
 * already-expanded set is served from the module cache with no round trip, and
 * an empty set resolves synchronously without asking at all.
 *
 * A server-side cycle, conflict, or unknown include name is refused; the
 * last-good expansion is kept and `error` carries the message, so the caller
 * can revert the include that broke it.
 *
 * @param {string[]} includes The include set to expand.
 * @return {{expansion: Object, error: string|null, loading: boolean}} The
 *         composed `{ nodes, edges, tree, hulls }`, the last failure message,
 *         and whether a round trip is in flight.
 */
export function useExpandedIncludes( includes ) {
	const key = ( includes || [] ).join( ' ' );

	// Bumped when the cache moves, so this re-reads it.
	const [ , bump ] = useState( 0 );
	const [ error, setError ] = useState( null );

	const { run } = useCommandOnce( {
		ci: 'topologies',
		command: 'expand',
		retry: true,
		onDone: ( { result, error: refusal, args } ) => {
			if ( refusal ) {
				setError( refusal );
			} else {
				cache.set( args.join( ' ' ), shape( result ) );
			}
			bump( ( n ) => n + 1 );
		},
	} );

	useEffect( () => {
		setError( null );
		if ( '' !== key && ! cache.has( key ) ) {
			run( formatCommandArgs( key.split( ' ' ) ) );
		}
	}, [ key, run ] );

	return {
		expansion: ( '' === key ? EMPTY : cache.get( key ) ) ?? EMPTY,
		error,
		loading: '' !== key && ! cache.has( key ) && null === error,
	};
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

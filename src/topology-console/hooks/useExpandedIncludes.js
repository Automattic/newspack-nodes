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
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';

const EMPTY = { nodes: [], edges: [], tree: {}, hulls: {} };

const cache = new Map();

// @longform
// The keys still to ask about, and who is waiting on each. The console mounts
// ONE expand hook and it does all the asking, one at a time; a caller that
// needs an expansion mid-flow (an upload, whose .tsl has includes but no
// expansion shipped with it) parks its key here and is woken when the answer
// lands. Nothing here mints a command — the hook's one-shot does, on the router
// tick, in the batch with everything else.
const waiting = new Map();
let wake = () => {};

/**
 * Queue a key to ask about, with nobody waiting on the answer.
 *
 * @param {string} key The joined include set.
 */
function want( key ) {
	if ( ! waiting.has( key ) ) {
		waiting.set( key, [] );
	}
}

/** @return {?string} The next queued key with no answer yet. */
function nextWanted() {
	for ( const key of waiting.keys() ) {
		if ( ! cache.has( key ) ) {
			return key;
		}
	}
	return null;
}

/**
 * Hand an arrived expansion to everyone waiting on it.
 *
 * @param {string} key       The joined include set.
 * @param {Object} expansion `{ nodes, edges, tree, hulls }`.
 */
function settle( key, expansion ) {
	cache.set( key, expansion );
	const waiters = waiting.get( key ) || [];
	waiting.delete( key );
	waiters.forEach( ( { resolve } ) => resolve( expansion ) );
}

/**
 * Fail everyone waiting on a key the server refused — a cycle, a conflict, an
 * unknown include name. A refusal is an answer, so the key leaves the queue.
 *
 * @param {string} key    The joined include set.
 * @param {string} reason The refusal text.
 */
function refuse( key, reason ) {
	const waiters = waiting.get( key ) || [];
	waiting.delete( key );
	waiters.forEach( ( { reject } ) => reject( new Error( reason ) ) );
}

/**
 * Fail everyone still waiting, because nothing is left to ask for them. The
 * hook that does the asking has gone; a key parked now would never settle, and
 * its caller — mid-load, awaiting a baseline — would hang there rather than
 * unwind.
 *
 * @param {string} reason The refusal text.
 */
function refuseAll( reason ) {
	for ( const key of [ ...waiting.keys() ] ) {
		refuse( key, reason );
	}
}

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
	settle( includes.join( ' ' ), shape( expansion ) );
}

/**
 * The composed expansion for a load that needs it BEFORE the draft is set —
 * `applyLoadedBaseline` subtracts `disconnects` against it, and the reactive
 * pass below only reacts AFTER.
 *
 * It sends nothing itself. The key is parked for the console's expand hook,
 * which asks on the next tick, and the promise settles when the answer lands —
 * or immediately, when the cache already holds it (a `topologies get` ships the
 * expansion with the file, and `primeExpandedIncludes` puts it here).
 *
 * @param {string[]} includes Directly-declared includes to expand.
 * @return {Promise<Object>} `{ nodes, edges, tree, hulls }`; empty when
 *                           `includes` is empty.
 */
export function fetchExpandedIncludes( includes ) {
	if ( ! includes || ! includes.length ) {
		return Promise.resolve( EMPTY );
	}
	const key = includes.join( ' ' );
	const cached = cache.get( key );
	if ( cached ) {
		return Promise.resolve( cached );
	}
	return new Promise( ( resolve, reject ) => {
		waiting.set( key, [
			...( waiting.get( key ) || [] ),
			{ resolve, reject },
		] );
		wake();
	} );
}

/**
 * Track the composed expansion of the draft's include set, reactively — and,
 * being the console's ONE expand hook, work off whatever `fetchExpandedIncludes`
 * has parked as well. One ask at a time: a second `run()` over an outstanding
 * one would replace its arguments, and the first key would never be asked.
 *
 * The ask is a READ, so it retries until an answer lands: an expansion lost to
 * a refused session or a restarted worker resolves on its own. An
 * already-expanded set is served from the module cache with no round trip, and
 * an empty set resets synchronously without asking at all.
 *
 * A server-side cycle, conflict, or unknown include name is refused; the
 * last-good expansion is kept and `error` carries the message, so the caller
 * can revert the include that broke it.
 *
 * @param {string[]} includes The draft's directly-declared includes.
 * @return {{expansion: Object, error: string|null, loading: boolean}} The
 *         composed `{ nodes, edges, tree, hulls }`, the last failure message,
 *         and whether a round trip is in flight.
 */
export function useExpandedIncludes( includes ) {
	const key = ( includes || [] ).join( ' ' );

	// Bumped when the cache or the queue moves, so this re-reads them.
	const [ , bump ] = useState( 0 );
	const [ error, setError ] = useState( null );

	// The key of the ask in flight; one at a time.
	const askingRef = useRef( null );
	// `pump` reaches the reply handler through this, being defined after it.
	const pumpRef = useRef( () => {} );

	const { run } = useCommandOnce( {
		ci: 'topologies',
		command: 'expand',
		retry: true,
		onDone: ( { result, error: refusal, args } ) => {
			const asked = args.join( ' ' );
			askingRef.current = null;
			if ( refusal ) {
				refuse( asked, refusal );
				setError( refusal );
			} else {
				settle( asked, shape( result ) );
			}
			bump( ( n ) => n + 1 );
			// One ask at a time: the next key is asked for here or nowhere.
			pumpRef.current();
		},
	} );

	// Ask for the next queued key, unless one is already outstanding.
	const pump = useCallback( () => {
		if ( askingRef.current ) {
			return;
		}
		const next = nextWanted();
		if ( next ) {
			askingRef.current = next;
			run( formatCommandArgs( next.split( ' ' ) ) );
		}
	}, [ run ] );

	// A parked key has nobody else to ask for it; wake this hook for it.
	pumpRef.current = pump;
	useEffect( () => {
		const waker = () => {
			bump( ( n ) => n + 1 );
			pumpRef.current();
		};
		wake = waker;
		return () => {
			// A later mount already took over; leave its waker alone.
			if ( wake !== waker ) {
				return;
			}
			wake = () => {};
			refuseAll( 'the graph was torn down' );
		};
	}, [] );

	// The draft's own set joins the same queue; then work the queue.
	useEffect( () => {
		setError( null );
		if ( '' !== key && ! cache.has( key ) ) {
			want( key );
		}
		pump();
	}, [ key, pump ] );

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

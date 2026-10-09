/**
 * useExpandedIncludes — the composed expansion of a console document's include
 * set: the nodes, edges, include tree and hulls its `include` lines bring in.
 *
 * A document's own body is half of what the canvas draws. The server composes
 * the other half, and the console asks for it once per include set; an empty
 * set asks nothing. `topologies get` ships the expansion with the file it
 * opens, so `primeExpandedIncludes()` files that answer and the hook finds it
 * already cached rather than asking a second time for the same thing.
 *
 * The server refuses a cycle, a conflicting `make_node` and an unknown include
 * name. The refusal arrives as `error` while the expansion reads empty — which
 * `expansionMatchesIncludes()` rejects, so a caller seeding from it keeps what
 * it has and can revert the include that broke it. The revert costs no round
 * trip, because the previous set is still cached.
 */

import { useEffect, useState } from '@wordpress/element';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../../runtime/command-args';
import { TOPOLOGIES_CI } from './useCatalogs';

/** What an unasked, unanswered or refused include set expands to. */
const EMPTY = { nodes: [], edges: [], tree: {}, hulls: {} };

/**
 * Expansions by joined include string, at module scope so the load handler
 * that primes one and the hook that reads it share a single map, and so
 * neither loses it to a remount of the console.
 *
 * Declaration order belongs in the key because it belongs to the answer: an
 * edge's `origin` list is ordered by the include set as the caller declared
 * it. An entry is a stable object, so a caller may drive an effect off the
 * expansion without that effect re-running on every render.
 */
const cache = new Map();

/** Bumped by each invalidation, so a mounted hook asks its set again. */
let generation = 0;

/** The re-render of every mounted hook, which an invalidation calls. */
const listeners = new Set();

/**
 * The cache key and command tokens of an include set: its names, then the
 * flag that asks for each Vault_Group as written when the editor wants that.
 *
 * @param {string[]} includes      Directly-declared includes.
 * @param {boolean}  groupChildren False asks for the groups without members.
 * @return {string} The joined key; the tokens are its words.
 */
function expansionKey( includes, groupChildren ) {
	return [
		...includes,
		...( groupChildren ? [] : [ '--group_children=false' ] ),
	].join( ' ' );
}

/**
 * Fill in whatever an expansion left out.
 *
 * Both ways into the cache pass through here — the `topologies expand` reply
 * and the expansion an open primes — so every reader gets four lists and none
 * of them guards for a missing one.
 *
 * @param {?Object} value The reply payload, or a primed expansion.
 * @return {Object} `{ nodes, edges, tree, hulls }`, each one present.
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
 *
 * A mounted hook whose include set is unchanged asks for it again, because its
 * key alone would never re-run the ask and it would read empty from then on.
 *
 * No reply to an ask made before the invalidation reaches the hook. Each ask
 * names the generation it was made under as its subject, which its reply
 * carries back in its address, so the re-ask is a new question that
 * supersedes the outstanding one rather than a repeat it absorbs; a hook that
 * leaves its set in the same render asks nothing, and withdraws what it had
 * outstanding instead. A refusal echoing no arguments passes the slice's gate
 * either way, so the hook drops a reply whose subject is an older generation.
 */
export function invalidateExpandedIncludes() {
	cache.clear();
	generation++;
	listeners.forEach( ( rerender ) => rerender( ( n ) => n + 1 ) );
}

/**
 * Seed the cache with an expansion that arrived some other way (`topologies
 * get` ships one with the file), so the hook serves it without a round trip.
 *
 * An empty include set or a missing expansion stores nothing. The empty set
 * needs no entry, and filing a missing expansion would leave a real include
 * set answered by an empty graph the hook then never asks about again.
 *
 * @param {string[]} includes                Directly-declared includes the expansion covers.
 * @param {?Object}  expansion               `{ nodes, edges, tree, hulls }`.
 * @param {Object}   [options]               Options.
 * @param {boolean}  [options.groupChildren] False files the form that leaves each Vault_Group as written.
 */
export function primeExpandedIncludes(
	includes,
	expansion,
	{ groupChildren = true } = {}
) {
	if ( ! includes || ! includes.length || ! expansion ) {
		return;
	}
	cache.set( expansionKey( includes, groupChildren ), shape( expansion ) );
}

/**
 * Track the composed expansion of an include set, reactively.
 *
 * The ask is a READ, so it keeps asking until an answer lands: an expansion
 * lost to a refused session or a restarted worker resolves on its own, and a
 * new include set SUPERSEDES the old one rather than queueing behind it, since
 * nobody wants the previous document's graph once a second one is open. An
 * already-expanded set is served from the module cache with no round trip, and
 * an empty set resolves synchronously without asking at all.
 *
 * A refusal ends `loading` although nothing is cached. A cycle, a conflicting
 * `make_node` or an unknown include name never resolves, so a spinner gated on
 * the cache alone would turn forever.
 *
 * @param {string[]} [includes]              The include set to expand; a missing one reads
 *                                           as empty.
 * @param {Object}   [options]               Options.
 * @param {boolean}  [options.groupChildren] False asks for each Vault_Group as
 *                                           written, none of its members: the editor's form.
 * @return {{expansion: Object, error: string|null, loading: boolean}} The
 *         composed `{ nodes, edges, tree, hulls }` — empty until the answer
 *         lands, and empty when it was refused — the refusal message, and
 *         whether a round trip is in flight.
 */
export function useExpandedIncludes( includes, { groupChildren = true } = {} ) {
	const names = includes || [];
	const key = 0 === names.length ? '' : expansionKey( names, groupChildren );

	// Bumped when the cache moves, so this re-reads it.
	const [ , bump ] = useState( 0 );
	const [ error, setError ] = useState( null );

	const { run, abandon } = useCommandOnce( {
		group: TOPOLOGIES_CI,
		ci: TOPOLOGIES_CI,
		command: 'expand',
		retry: true,
		subjectOf: () => String( generation ),
		onDone: ( { result, error: refusal, args, subject } ) => {
			// The gate passes a refusal echoing no arguments, standing or not.
			if ( String( generation ) !== subject ) {
				return;
			}
			if ( refusal ) {
				setError( refusal );
			} else {
				cache.set( args.join( ' ' ), shape( result ) );
			}
			bump( ( n ) => n + 1 );
		},
	} );

	useEffect( () => {
		listeners.add( bump );
		return () => {
			listeners.delete( bump );
		};
	}, [] );

	const asked = generation;
	useEffect( () => {
		setError( null );
		if ( '' !== key && ! cache.has( key ) ) {
			run( formatCommandArgs( key.split( ' ' ) ) );
		} else {
			abandon();
		}
	}, [ key, run, abandon, asked ] );

	return {
		expansion: ( '' === key ? EMPTY : cache.get( key ) ) ?? EMPTY,
		error,
		loading: '' !== key && ! cache.has( key ) && null === error,
	};
}

/**
 * Whether an expansion answers exactly this document's includes.
 *
 * `topologies expand` keys its `tree` by the direct includes that resolved, so
 * the top-level keys are exactly what was asked for. Opening a child topology
 * leaves the PARENT's expansion in state for a tick, and re-seeding from it
 * marks the child's own nodes borrowed — after which the document stops
 * declaring them and a save writes an empty file. The same check tells a
 * parked upload that ITS answer has landed: an empty tree against declared
 * includes is a set still in flight, or one the server refused.
 *
 * @param {?Object}  expansion `topologies expand` result; a missing one
 *                             matches only a document declaring no includes.
 * @param {string[]} includes  The document's direct includes.
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

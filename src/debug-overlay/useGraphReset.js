import { useState, useEffect, useRef, useCallback } from '@wordpress/element';
import { Core } from '../runtime/core';
import { VALUE } from '../runtime/message';

// Verbs (and their interpreter aliases) that create or destroy a node.
const CREATE_VERBS = new Set( [ 'make_node', 'make' ] );
const REMOVE_VERBS = new Set( [ 'remove_node', 'remove', 'rm' ] );

// Every verb that structurally mutates the graph.
const MUTATING_VERBS = new Set( [
	...CREATE_VERBS,
	...REMOVE_VERBS,
	'connect_node',
	'connect',
	'disconnect_node',
	'disconnect',
] );

/**
 * The node a create/remove verb names: `make_node <Class> <name>` puts it
 * second, `remove_node <name>` first. Every producer routes through
 * `Shell_Node`, which tokenizes, so arguments are always a token array.
 *
 * Returns undefined for the wiring verbs, whose first token is a node that
 * already exists — connecting two nodes creates neither.
 *
 * @param {string}   verb The dispatched verb.
 * @param {string[]} args Its arguments.
 * @return {string|undefined} The created or removed node, else undefined.
 */
function nodeNameOf( verb, args ) {
	const argv = Array.isArray( args ) ? args : [];
	if ( CREATE_VERBS.has( verb ) ) {
		return argv[ 1 ];
	}
	// `remove_node -a <regex>` removes by pattern; not a single name.
	return REMOVE_VERBS.has( verb ) && ! argv[ 0 ]?.startsWith( '-' )
		? argv[ 0 ]
		: undefined;
}

/**
 * useGraphReset — shared graph-dirty + Reset Graph logic for BOTH the debug
 * overlay and the topology console (one implementation, identical behavior).
 *
 * Structure-dirty is driven by a tap on the Shell's dispatch: every
 * graph-mutating command (make_node / connect_node / disconnect_node /
 * remove_node, + aliases) flips it — whether it came from a canvas gesture, an
 * Inspector action, or a typed REPL line. That uniformity is what keeps the
 * Reset Graph chip in sync: tapping the single dispatch point catches REPL
 * rewires that per-handler dirtying would miss.
 *
 * resetGraph mirrors the overlay's proven sequence: tear down every node, bump
 * the graph generation so each builder rebuilds off the canonical wiring, clear
 * dirty, and markDirty() the layout so Reset Layout surfaces (the layout itself
 * is kept — no shift).
 *
 * canResetGraph surfaces the chip when EITHER a mutating command flipped
 * structureDirty (rewire/disconnect — invisible to a node scan) OR a node the
 * shell minted is still on the canvas (presence survives a shell rebuild that
 * clears structureDirty, e.g. a topology change).
 *
 * Both halves read the SAME dispatch tap, which is what makes "user-added"
 * a recorded fact rather than a guess. It used to be inferred — a node counted
 * unless it was reserved, or listed in `Core.reinitNames`, or its class set
 * `isSystemNode` — so three registries had to agree and nothing enforced it.
 * Anything minted outside a `mountExospine` build (every `useRouterTick`
 * timer, `useConsoleGraph`'s bare-mount RemoteIpc) read as user-added and
 * stuck the chip on permanently, since resetGraph's rebuild recreates it.
 *
 * @param {Object}   params              Hook options.
 * @param {?Object}  params.shell        The session Shell (its onDispatch is tapped).
 * @param {?Array}   params.nodes        Live graph nodes ({id}); matched against the shell-minted set.
 * @param {boolean}  params.isLocalScope Reset only makes sense on the in-browser graph.
 * @param {boolean}  params.canRebuild   A rebuild path exists (overlay: reinit; console: mounted).
 * @param {Function} params.markDirty    Layout-dirty hook; called on every structural mutation (and by resetGraph) so Reset Layout surfaces alongside Reset Graph.
 * @return {{structureDirty: boolean, resetGraph: Function, canResetGraph: boolean}} Reset state.
 */
export function useGraphReset( {
	shell,
	nodes,
	isLocalScope,
	canRebuild,
	markDirty,
} ) {
	const [ structureDirty, setStructureDirty ] = useState( false );
	// Shell-minted names; survives a shell swap (the nodes outlive it).
	const [ userNames, setUserNames ] = useState( () => new Set() );

	// Latest markDirty, read by the stable tap closure (deps=[shell] only).
	const markDirtyRef = useRef( markDirty );
	markDirtyRef.current = markDirty;

	// Tap Shell dispatch chokepoint; a mutating verb flips dirty + markDirty.
	useEffect( () => {
		if ( ! shell ) {
			return undefined;
		}
		// A fresh shell means a rebuilt (canonical) graph — clear stale dirty.
		setStructureDirty( false );
		const tap = ( message ) => {
			const name = message?.[ VALUE ]?.name;
			if ( ! name || ! MUTATING_VERBS.has( name ) ) {
				return;
			}
			setStructureDirty( true );
			markDirtyRef.current();
			const target = nodeNameOf( name, message[ VALUE ]?.arguments );
			if ( ! target ) {
				return;
			}
			setUserNames( ( prev ) => {
				if ( CREATE_VERBS.has( name ) ) {
					return new Set( prev ).add( target );
				}
				if ( ! prev.has( target ) ) {
					return prev;
				}
				const next = new Set( prev );
				next.delete( target );
				return next;
			} );
		};
		shell.onDispatch = tap;
		return () => {
			if ( shell.onDispatch === tap ) {
				shell.onDispatch = null;
			}
		};
	}, [ shell ] );

	const resetGraph = useCallback( () => {
		// Remove EVERY node (orphan user nodes have no owner to rebuild them)…
		for ( const node of [ ...Core.nodes.values() ] ) {
			node.removeNode();
		}
		// …then bump: each builder tears down + rebuilds off canonical wiring.
		Core.bumpGraphGeneration();
		setStructureDirty( false );
		setUserNames( new Set() );
		// Keep the layout; surface Reset Layout so the user can re-autofit.
		markDirtyRef.current();
	}, [] );

	// A shell-minted node still on the canvas.
	const hasUserNodes =
		!! isLocalScope &&
		( nodes ?? [] ).some( ( n ) => userNames.has( n.id ) );

	const canResetGraph =
		!! isLocalScope && !! canRebuild && ( structureDirty || hasUserNodes );

	return { structureDirty, resetGraph, canResetGraph };
}

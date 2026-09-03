import { useState, useEffect, useRef, useCallback } from '@wordpress/element';
import { Core } from '../runtime/core';
import { VALUE } from '../runtime/message';

/** `make_node` and the interpreter alias that mint a node. */
const CREATE_VERBS = new Set( [ 'make_node', 'make' ] );

/** `remove_node` and the interpreter aliases that tear one down. */
const REMOVE_VERBS = new Set( [ 'remove_node', 'remove', 'rm' ] );

/**
 * Every verb that structurally mutates the graph: the create and remove verbs
 * plus the wiring pair, each with its interpreter aliases.
 *
 * The Shell announces a dispatch without inspecting it, so this set is where a
 * verb becomes "structural". An interpreter verb that rewires the graph and is
 * missing here leaves its edit invisible to the Reset Graph chip.
 */
const MUTATING_VERBS = new Set( [
	...CREATE_VERBS,
	...REMOVE_VERBS,
	'connect_node',
	'connect',
	'disconnect_node',
	'disconnect',
] );

/**
 * The node a create or remove verb names: `make_node <Class> <name>` puts it
 * second, `remove_node <name>` first. Every producer routes through
 * `Shell_Node`, which tokenizes, so arguments arrive as a token array; any
 * other shape reads as no arguments.
 *
 * Three forms yield undefined. The wiring verbs are not in either set, and
 * their first token is a node that already exists — connecting two nodes
 * creates neither. `remove_node -a <regex>` removes by pattern rather than by
 * name. `remove_node` also takes further names after the first, and only the
 * first comes back; the rest stay in the shell-minted set, where they match no
 * live node and so cannot hold the chip on.
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
 * Graph-dirty state and the Reset Graph action, shared by the debug overlay
 * and the topology console so the chip behaves identically on both.
 *
 * `structureDirty` is driven by a tap on the Shell's single dispatch
 * chokepoint: every graph-mutating command flips it, whether it came from a
 * canvas gesture, an Inspector action or a typed REPL line. Tapping the one
 * dispatch point is what keeps the chip in sync — dirtying inside each GUI
 * handler instead sees the gestures and misses a REPL rewire.
 *
 * `resetGraph` tears down every node, bumps the graph generation so each
 * builder rebuilds off the canonical wiring, clears dirty, and marks the
 * LAYOUT dirty. The layout itself survives, so the canvas does not shift, and
 * Reset Layout surfaces beside it for a re-autofit.
 *
 * `canResetGraph` is true when either a mutating command flipped
 * `structureDirty` — a rewire or disconnect, invisible to a node scan — or a
 * node the shell minted is still on the canvas. That second half survives a
 * shell rebuild, which clears `structureDirty`; a topology change is one.
 *
 * Both halves read the SAME dispatch tap, which makes "user-added" a recorded
 * fact rather than a guess. Inferring it from the node registry instead counts
 * anything minted outside a `mountExospine` build — every `useRouterTick`
 * timer, `useConsoleGraph`'s bare-mount RemoteIpc — as user-added, and pins the
 * chip on permanently, because resetGraph's rebuild recreates it.
 *
 * @param {Object}   params              Hook options.
 * @param {?Object}  params.shell        The session Shell; the hook claims its `onDispatch` tap.
 * @param {?Array}   params.nodes        Live graph nodes ({id}), matched against the shell-minted names.
 * @param {boolean}  params.isLocalScope The in-browser graph is in view (empty cwd) — a remote worker's graph is not resettable from here.
 * @param {boolean}  params.canRebuild   A rebuild path exists: the overlay passes `Core.rebuildable`, the console passes "not in edit mode".
 * @param {Function} params.markDirty    Layout-dirty hook, called on every structural mutation and by resetGraph so Reset Layout surfaces alongside Reset Graph.
 * @return {{structureDirty: boolean, resetGraph: Function, canResetGraph: boolean}} The dirty flag, the reset action, and whether to offer it.
 */
export function useGraphReset( {
	shell,
	nodes,
	isLocalScope,
	canRebuild,
	markDirty,
} ) {
	const [ structureDirty, setStructureDirty ] = useState( false );
	// Shell-minted names; the set outlives the shell that recorded them.
	const [ userNames, setUserNames ] = useState( () => new Set() );

	// Latest markDirty, read by the stable tap closure (deps are [shell]).
	const markDirtyRef = useRef( markDirty );
	markDirtyRef.current = markDirty;

	// Tap the Shell dispatch chokepoint: a mutating verb flips both flags.
	useEffect( () => {
		if ( ! shell ) {
			return undefined;
		}
		// A fresh shell means a rebuilt, canonical graph; clear stale dirty.
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
		// Remove every node; an orphan user node has no owner to rebuild it.
		for ( const node of [ ...Core.nodes.values() ] ) {
			node.removeNode();
		}
		// Then bump: each builder tears down and rebuilds off canonical wiring.
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

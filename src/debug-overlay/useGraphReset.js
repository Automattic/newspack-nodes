import { useState, useEffect, useRef, useCallback } from '@wordpress/element';
import { Core } from '../runtime/core';
import { VALUE } from '../runtime/message';
import { isCommandAsk } from '../runtime/command-auth';

/** `make_node` and the interpreter alias that mint a node. */
const CREATE_VERBS = new Set( [ 'make_node', 'make' ] );

/** `remove_node` and the interpreter aliases that tear one down. */
const REMOVE_VERBS = new Set( [ 'remove_node', 'remove', 'rm' ] );

/** `move_node` and the interpreter aliases that rename one. */
const MOVE_VERBS = new Set( [ 'move_node', 'move', 'mv' ] );

/**
 * Every verb that structurally mutates the graph: the create, remove and move
 * verbs, the wiring pair, `set_sink` and the listener pair `register` and
 * `unregister`, each with its interpreter aliases.
 *
 * The gate announces a forward without inspecting it, so this set is where a
 * verb becomes "structural". An interpreter verb that rewires the graph and is
 * missing here leaves its edit invisible to the Reset Graph chip.
 */
const MUTATING_VERBS = new Set( [
	...CREATE_VERBS,
	...REMOVE_VERBS,
	...MOVE_VERBS,
	'set_sink',
	'register',
	'unregister',
	'connect_node',
	'connect',
	'disconnect_node',
	'disconnect',
] );

/**
 * The node a create, remove or move verb names: `make_node <Class> <name>` puts
 * it second, `remove_node <name>` and `move_node <name> <new name>` first. Every producer tokenizes — the Shell, and
 * the Compose modal through the Shell's tokenizer — so arguments arrive as a
 * token array; any other shape reads as no arguments.
 *
 * Three forms yield undefined. The wiring verbs are not in either set, and
 * their first token is a node that already exists — connecting two nodes
 * creates neither. `remove_node -a <regex>` removes by pattern rather than by
 * name. `remove_node` also takes further names after the first, and only the
 * first comes back; the rest stay in the console-minted set, where they match
 * no live node and so cannot hold the chip on.
 *
 * @param {string}   verb The dispatched verb.
 * @param {string[]} args Its arguments.
 * @return {string|undefined} The created, removed or moved node, else undefined.
 */
function nodeNameOf( verb, args ) {
	const argv = Array.isArray( args ) ? args : [];
	if ( CREATE_VERBS.has( verb ) ) {
		return argv[ 1 ];
	}
	if ( MOVE_VERBS.has( verb ) ) {
		return argv[ 0 ];
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
 * `structureDirty` is driven by the outgoing gate's `onForward` tap, the one
 * chokepoint every console send passes: every graph-mutating command flips
 * it, whether it came from a canvas gesture, an Inspector action, a typed REPL
 * line or the Compose modal. Tapping the one send point is what keeps the chip
 * in sync — dirtying inside each GUI handler instead sees the gestures and
 * misses a REPL rewire.
 *
 * `resetGraph` tears down every node, bumps the graph generation so each
 * builder rebuilds off the canonical wiring, clears dirty, and marks the
 * LAYOUT dirty. The layout itself survives, so the canvas does not shift, and
 * Reset Layout surfaces beside it for a re-autofit.
 *
 * `canResetGraph` is true when either a mutating command flipped
 * `structureDirty` — a rewire or disconnect, invisible to a node scan — or a
 * node the console minted is still on the canvas. That second half survives a
 * Shell rebuild, which clears `structureDirty`; a topology change is one.
 *
 * Both halves read the SAME forward tap, which makes "user-added" a recorded
 * fact rather than a guess. Inferring it from the node registry instead counts
 * anything minted outside a `mountExospine` build — every `useRouterTick`
 * timer, `useConsoleGraph`'s bare-mount RemoteIpc — as user-added, and pins the
 * chip on permanently, because resetGraph's rebuild recreates it.
 *
 * @param {Object}   params              Hook options.
 * @param {?Object}  params.gate         The console's outgoing gate; the hook claims its `onForward` tap.
 * @param {?Object}  params.shell        The session Shell; a new one is a rebuilt, canonical graph, which clears `structureDirty`.
 * @param {?Array}   params.nodes        Live graph nodes ({id}), matched against the console-minted names.
 * @param {boolean}  params.isLocalScope The in-browser graph is in view (empty cwd) — a remote worker's graph is not resettable from here.
 * @param {boolean}  params.canRebuild   A rebuild path exists: the overlay passes `Core.rebuildable`, the console passes "not in edit mode".
 * @param {Function} params.markDirty    Layout-dirty hook, called on every structural mutation and by resetGraph so Reset Layout surfaces alongside Reset Graph.
 * @return {{structureDirty: boolean, resetGraph: Function, canResetGraph: boolean}} The dirty flag, the reset action, and whether to offer it.
 */
export function useGraphReset( {
	gate,
	shell,
	nodes,
	isLocalScope,
	canRebuild,
	markDirty,
} ) {
	const [ structureDirty, setStructureDirty ] = useState( false );
	// Console-minted names; the set outlives the gate that recorded them.
	const [ userNames, setUserNames ] = useState( () => new Set() );

	// Latest markDirty, read by the stable tap closure (deps are [gate]).
	const markDirtyRef = useRef( markDirty );
	markDirtyRef.current = markDirty;

	// A fresh Shell means a rebuilt, canonical graph; clear stale dirty.
	useEffect( () => {
		setStructureDirty( false );
	}, [ shell ] );

	// Tap the gate's forward chokepoint: a mutating verb flips both flags.
	useEffect( () => {
		if ( ! gate ) {
			return undefined;
		}
		const tap = ( message ) => {
			// An answer — a refusal echoing a verb's name — is not an edit.
			if ( ! isCommandAsk( message ) ) {
				return;
			}
			let name = message?.[ VALUE ]?.name;
			let args = message?.[ VALUE ]?.arguments;
			// `reply_to <target> <verb> <args…>` runs its inner verb.
			if ( 'reply_to' === name && Array.isArray( args ) ) {
				[ , name, ...args ] = args;
			}
			if ( ! name || ! MUTATING_VERBS.has( name ) ) {
				return;
			}
			setStructureDirty( true );
			markDirtyRef.current();
			const target = nodeNameOf( name, args );
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
				// A console-made node keeps counting under its new name.
				const renamed = args?.[ 1 ];
				if ( MOVE_VERBS.has( name ) && renamed ) {
					next.add( renamed );
				}
				return next;
			} );
		};
		gate.onForward = tap;
		return () => {
			if ( gate.onForward === tap ) {
				gate.onForward = null;
			}
		};
	}, [ gate ] );

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

	// A console-minted node still on the canvas.
	const hasUserNodes =
		!! isLocalScope &&
		( nodes ?? [] ).some( ( n ) => userNames.has( n.id ) );

	const canResetGraph =
		!! isLocalScope && !! canRebuild && ( structureDirty || hasUserNodes );

	return { structureDirty, resetGraph, canResetGraph };
}

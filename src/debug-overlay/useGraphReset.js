/**
 * useGraphReset — shared graph-dirty + Reset Graph logic for BOTH the debug
 * overlay and the topology console (one implementation, identical behavior).
 *
 * Structure-dirty is driven by a tap on the Shell's dispatch: every
 * graph-mutating command (make_node / connect_node / disconnect_node /
 * remove_node, + aliases) flips it — whether it came from a canvas gesture, an
 * Inspector action, or a typed REPL line. That uniformity is what keeps the
 * Reset Graph chip in sync where the old per-handler dirtying missed REPL
 * rewires.
 *
 * resetGraph mirrors the overlay's proven sequence: tear down every node, bump
 * the graph generation so each builder rebuilds off the canonical wiring, clear
 * dirty, and markDirty() the layout so Reset Layout surfaces (the layout itself
 * is kept — no shift).
 *
 * canResetGraph surfaces the chip when EITHER a mutating command flipped
 * structureDirty (rewire/disconnect — invisible to a node scan) OR a user-added
 * node is present in the live graph (node presence survives a shell rebuild that
 * clears structureDirty, e.g. a topology change). This mirrors the overlay's
 * original `graphDirty || hasUserNodes`, with the tap fixing the REPL gap.
 *
 * @param {Object}   params
 * @param {?Object}  params.shell        The session Shell (its onDispatch is tapped).
 * @param {Array}    params.nodes        Live graph nodes ({id}); non-reserved = user-added.
 * @param {boolean}  params.isLocalScope Reset only makes sense on the in-browser graph.
 * @param {boolean}  params.canRebuild   A rebuild path exists (overlay: reinit; console: mounted).
 * @param {Function} params.markDirty    Layout-dirty hook (now a no-op; a graph rewire no longer dirties the layout).
 * @return {{structureDirty: boolean, resetGraph: Function, canResetGraph: boolean}} Reset state.
 */

import { useState, useEffect, useRef, useCallback } from '@wordpress/element';
import { Core } from '../runtime/core';
import { VALUE } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';

// Verbs (and their interpreter aliases) that structurally mutate the graph.
const MUTATING_VERBS = new Set( [
	'make_node',
	'make',
	'connect_node',
	'connect',
	'disconnect_node',
	'disconnect',
	'remove_node',
	'remove',
	'rm',
] );

// The substrate's own node names — anything else in the local graph is user-added.
const RESERVED_NAMES = new Set( Object.values( names ) );

export function useGraphReset( {
	shell,
	nodes,
	isLocalScope,
	canRebuild,
	markDirty,
} ) {
	const [ structureDirty, setStructureDirty ] = useState( false );

	// Latest markDirty, read by the stable tap closure (deps=[shell] only).
	const markDirtyRef = useRef( markDirty );
	markDirtyRef.current = markDirty;

	// Tap the Shell's single dispatch chokepoint; a mutating verb dirties both the
	// graph (Reset Graph) and the layout (Reset Layout — the node set changed, so
	// the saved layout may be stale).
	useEffect( () => {
		if ( ! shell ) {
			return undefined;
		}
		// A fresh shell means a rebuilt (canonical) graph — clear any stale dirty.
		setStructureDirty( false );
		const tap = ( message ) => {
			const name = message?.[ VALUE ]?.name;
			if ( name && MUTATING_VERBS.has( name ) ) {
				setStructureDirty( true );
				markDirtyRef.current();
			}
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
		// …then bump: each builder tears down + rebuilds off the canonical wiring.
		Core.bumpGraphGeneration();
		setStructureDirty( false );
		// Keep the layout; surface Reset Layout so the user can re-autofit.
		markDirtyRef.current();
	}, [] );

	// A user-added node present in the live graph — node presence outlives a shell
	// rebuild that clears structureDirty (a surviving node after a topology swap).
	const hasUserNodes =
		!! isLocalScope &&
		( nodes ?? [] ).some(
			( n ) =>
				! RESERVED_NAMES.has( n.id ) &&
				! ( Core.reinitNames ?? [] ).includes( n.id )
		);

	const canResetGraph =
		!! isLocalScope && !! canRebuild && ( structureDirty || hasUserNodes );

	return { structureDirty, resetGraph, canResetGraph };
}

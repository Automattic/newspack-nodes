/**
 * useCanvasLayout — where every node card sits on the schematic canvas, and
 * what of that survives a reload.
 *
 * The canvas draws only the nodes it finds in the position map, so the map has
 * to be complete: this hook seeds it once from `autoLayout` or from a worker
 * topology's server-saved layout, then mutates it on drags, palette drops and
 * tucks for nodes that arrive later. Positions and the viewport persist to
 * localStorage under one key per scope, which is what makes layout browser
 * state rather than part of the draft document; `LayoutContext` publishes the
 * result to the canvas and never writes it.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { autoLayout, placeBelow } from '../utils/autoLayout';

/**
 * The canvas value shapes, declared in `LayoutContext` and re-imported here so
 * what this hook stores and what the canvas draws cannot drift apart.
 *
 * @typedef {import('../LayoutContext').Position} Position
 * @typedef {import('../LayoutContext').ViewBox} ViewBox
 * @typedef {import('../LayoutContext').ViewportDelta} ViewportDelta
 */

/**
 * The graph being laid out: the nodes on the canvas and the edges between them.
 *
 * @typedef {{nodes: Array<{id: string}>, edges: Array<Object>}} Graph
 */

/**
 * One scope's layout state.
 *
 * `key` rides along so an effect that started under the previous scope can tell
 * that the scope has moved on and leave the new state alone. `modified` means a
 * person changed this layout: it gates the Reset Layout chip, and it is what
 * makes the browser map outrank a server layout that lands later. Storage keeps
 * `positions`, `viewportDelta` and `modified`; the other two are per-mount.
 *
 * @typedef  {Object}                   LayoutState
 * @property {?Object<string,Position>} positions     Node id to position, or null before the one-shot init runs.
 * @property {?ViewBox}                 viewport      Live viewBox, or null while the canvas autofits.
 * @property {?ViewportDelta}           viewportDelta The viewport as an offset from autofit, which is the durable form.
 * @property {boolean}                  modified      A person moved, dropped or reset something in this scope.
 * @property {?string}                  key           The storage key this state was built for.
 */

/**
 * The hook's return: the map to draw, the view to draw it through, and the five
 * mutators for the two.
 *
 * @typedef  {Object}                                        CanvasLayout
 * @property {Object<string,Position>}                       positions        Every node's position, complete because the canvas draws only what it finds here.
 * @property {?ViewBox}                                      viewport         Live viewBox, or null while the canvas autofits.
 * @property {?ViewportDelta}                                viewportDelta    The stored offset from autofit the canvas restores its view from.
 * @property {boolean}                                       canReset         A person changed this scope's layout, so Reset Layout has something to undo.
 * @property {(id: string, pos: Position) => void}           onPositionChange Commit one card's new position and mark the scope modified.
 * @property {(vp: ?ViewBox, delta: ?ViewportDelta) => void} onViewportChange Commit a pan or zoom; the write to storage is debounced.
 * @property {(oldId: string, newId: string) => void}        renamePosition   Carry an entry over to a renamed node, leaving `modified` alone.
 * @property {() => void}                                    markDirty        Light the Reset Layout chip without moving a card.
 * @property {() => void}                                    resetLayout      Forget the stored layout, so the graph is laid out again.
 */

/**
 * The zero state: nothing placed, no view, nothing to reset.
 *
 * Every fresh state spreads this and adds the scope's key, so `key` is never
 * missing and a stale effect always has something to compare against.
 */
const EMPTY = {
	positions: null,
	viewport: null,
	viewportDelta: null,
	modified: false,
};

/**
 * Read one scope's stored layout.
 *
 * `viewport` comes back null even for a scope that was panned: the durable form
 * is `viewportDelta`, and `SchematicCanvas` re-derives the live viewBox from it
 * once it knows its first autofit box. Re-deriving is what keeps a restored
 * view fitted after the window, overlay or transcript resized the canvas, and a
 * record carrying no delta simply autofits.
 *
 * @param {?string} key The scope's localStorage key.
 * @return {LayoutState} The stored layout, or the zero state when nothing is
 * stored, storage refuses, or what it holds does not parse.
 */
function load( key ) {
	// Null key (e.g. untitled draft) is in-memory only — never touch storage.
	if ( ! key ) {
		return { ...EMPTY, key };
	}
	try {
		const raw = window.localStorage.getItem( key );
		if ( ! raw ) {
			return { ...EMPTY, key };
		}
		const p = JSON.parse( raw );
		return {
			positions:
				p && typeof p.positions === 'object' && p.positions
					? sanitizePositions( p.positions )
					: null,
			viewport: null,
			viewportDelta:
				p && p.viewportDelta !== undefined ? p.viewportDelta : null,
			modified: !! ( p && p.modified ),
			key,
		};
	} catch ( _e ) {
		return { ...EMPTY, key };
	}
}

/**
 * Write one scope's durable layout: positions, viewport delta and dirty flag.
 *
 * The live viewBox stays out of storage deliberately. Absolute coordinates
 * restore a view that no longer fits once the canvas has been resized, so the
 * offset from autofit is the only viewport form worth keeping.
 *
 * @param {?string}     key The scope's localStorage key.
 * @param {LayoutState} s   The state to write.
 */
function persist( key, s ) {
	// A null key (untitled draft) is in-memory only — never write storage.
	if ( ! key ) {
		return;
	}
	try {
		window.localStorage.setItem(
			key,
			JSON.stringify( {
				positions: s.positions,
				viewportDelta: s.viewportDelta,
				modified: s.modified,
			} )
		);
	} catch ( _e ) {
		// localStorage disabled / quota — in-session only.
	}
}

/**
 * Restrict a position map to the nodes currently on the canvas.
 *
 * `placeBelow` anchors on the left-most-then-bottom-most entry it is handed, so
 * an entry left behind by a deleted node would tuck new cards underneath a card
 * nobody can see.
 *
 * @param {Object<string,Position>} positions Every position the scope knows.
 * @param {Array<{id: string}>}     nodes     The nodes on the canvas.
 * @return {Object<string,Position>} The on-screen subset.
 */
function visiblePositions( positions, nodes ) {
	/** @type {Object<string,Position>} */
	const out = {};
	for ( const n of nodes ) {
		if ( positions[ n.id ] ) {
			out[ n.id ] = positions[ n.id ];
		}
	}
	return out;
}

/**
 * Complete a server layout so every node on the canvas has a position.
 *
 * A saved layout records the nodes that existed when someone saved it, and the
 * canvas draws only what the map holds. Tucking the rest below the placed cards
 * is what keeps a node added since then visible.
 *
 * @param {Object<string,Position>} serverLayout The saved id-to-position map.
 * @param {Array<{id: string}>}     nodes        The nodes on the canvas.
 * @return {Object<string,Position>} The completed map.
 */
function materializeServerPositions( serverLayout, nodes ) {
	const positions = { ...serverLayout };
	const visible = visiblePositions( positions, nodes );
	for ( const n of nodes ) {
		if ( ! positions[ n.id ] ) {
			const position = placeBelow( visible );
			positions[ n.id ] = position;
			visible[ n.id ] = position;
		}
	}
	return positions;
}

/**
 * Drop every stored entry that is not a finite `{x, y}` pair.
 *
 * Storage is not trusted input: a NaN coordinate serializes to null, and the
 * stored copy outlives the bug that wrote it. `modified` makes the browser copy
 * beat the server layout, and the one-shot init skips a non-null map, so the
 * card would stay off-graph. Dropping the bad entries lets the tuck re-place
 * them.
 *
 * @param {Object<string,*>} positions The parsed map, unvalidated.
 * @return {Object<string,Position>} Only the entries the canvas can draw.
 */
function sanitizePositions( positions ) {
	/** @type {Object<string,Position>} */
	const clean = {};
	for ( const [ id, position ] of Object.entries( positions ) ) {
		if ( isPosition( position ) ) {
			clean[ id ] = position;
		}
	}
	return clean;
}

/**
 * Is this value a position the canvas can draw?
 *
 * @param {*} value The candidate.
 * @return {boolean} True for an object carrying finite `x` and `y`.
 */
function isPosition( value ) {
	return (
		value !== null &&
		typeof value === 'object' &&
		Number.isFinite( value.x ) &&
		Number.isFinite( value.y )
	);
}

/**
 * Do two maps hold the same ids at the same coordinates?
 *
 * The late-server reconcile asks this to tell an acknowledgement from a
 * conflict: an equal map means the server has caught up with the browser's
 * edits, so the dirty flag clears without a card moving.
 *
 * @param {Object<string,Position>} left  One map.
 * @param {Object<string,Position>} right The other.
 * @return {boolean} True when they match entry for entry.
 */
function positionsEqual( left, right ) {
	const leftIds = Object.keys( left );
	const rightIds = Object.keys( right );
	return (
		leftIds.length === rightIds.length &&
		leftIds.every( ( id ) => {
			const leftPosition = left[ id ];
			const rightPosition = right[ id ];
			return (
				isPosition( leftPosition ) &&
				isPosition( rightPosition ) &&
				leftPosition.x === rightPosition.x &&
				leftPosition.y === rightPosition.y
			);
		} )
	);
}

/**
 * How long the node set must stop growing before the one-shot layout runs.
 *
 * Nodes stream in a batch at a time and `autoLayout` runs once, so laying out
 * on the first batch would freeze half a topology into positions the rest has
 * to live around.
 */
const LAYOUT_SETTLE_MS = 250;

/**
 * The canvas position map: built once when the complete graph is ready — by
 * `autoLayout`, or from the server layout for a worker topology — then
 * reconciled with a late server layout or mutated by drags, drops and tucks.
 * `autoLayout` never runs again except through `resetLayout`.
 *
 * Dirty browser positions outrank a server layout that arrives afterwards until
 * the two maps agree, at which point the acknowledgement clears the dirty flag
 * without moving a card. Otherwise a fetch landing after a drag would snap
 * every card back to what the server last saved.
 *
 * @param {Object}  opts
 * @param {?string} opts.storageKey     localStorage key, one per scope. Null for an untitled draft, which never persists.
 * @param {Graph}   opts.graph          The COMPLETE graph for the scope.
 * @param {boolean} opts.ready          Graph fully built, and the server fetch resolved for a worker scope.
 * @param {?Object} [opts.serverLayout] The worker topology's saved layout, an id-to-`{x, y}` map, or null when none is stored.
 * @return {CanvasLayout} This scope's layout and its mutators.
 */
export function useCanvasLayout( {
	storageKey,
	graph,
	ready,
	serverLayout = null,
} ) {
	const [ state, setState ] = useState( () => load( storageKey ) );
	const stateRef = useRef( state );
	stateRef.current = state;
	const vpTimer = useRef( null );
	const settleTimer = useRef( null );

	// Reload on scope switch; cancel any pending viewport write.
	useEffect( () => {
		if ( vpTimer.current ) {
			clearTimeout( vpTimer.current );
			vpTimer.current = null;
		}
		setState( load( storageKey ) );
	}, [ storageKey ] );

	// One-shot init / late server reconcile; a concurrent key-change wins.
	useEffect( () => {
		if ( ! ready ) {
			return undefined;
		}
		const nodes = graph?.nodes ?? [];
		if ( nodes.length === 0 ) {
			return undefined;
		}

		// Dirty browser positions win until the complete server map matches.
		if ( serverLayout && Object.keys( serverLayout ).length > 0 ) {
			const serverPositions = materializeServerPositions(
				serverLayout,
				nodes
			);
			setState( ( prev ) => {
				if ( prev.key !== storageKey ) {
					return prev;
				}
				const matches =
					prev.positions !== null &&
					positionsEqual( prev.positions, serverPositions );
				if ( prev.positions !== null && prev.modified && ! matches ) {
					return prev;
				}
				if ( matches ) {
					if ( ! prev.modified ) {
						return prev;
					}
					const acknowledged = { ...prev, modified: false };
					persist( storageKey, acknowledged );
					return acknowledged;
				}
				const next = {
					positions: serverPositions,
					viewport: prev.viewport,
					viewportDelta: prev.viewportDelta,
					modified: false,
					key: storageKey,
				};
				persist( storageKey, next );
				return next;
			} );
			return undefined;
		}

		// Already initialized for this scope — graph growth is the tuck job.
		if ( state.positions !== null && state.key === storageKey ) {
			return undefined;
		}

		// No saved layout: wait for the node set to SETTLE, then lay out.
		settleTimer.current = setTimeout( () => {
			settleTimer.current = null;
			setState( ( prev ) => {
				if ( prev.positions !== null || prev.key !== storageKey ) {
					return prev;
				}
				/** @type {Object<string,Position>} */
				const positions = {};
				for ( const n of autoLayout( graph ).nodes ) {
					positions[ n.id ] = n.position;
				}
				const next = {
					positions,
					viewport: prev.viewport,
					viewportDelta: prev.viewportDelta,
					modified: false,
					key: storageKey,
				};
				persist( storageKey, next );
				return next;
			} );
		}, LAYOUT_SETTLE_MS );
		return () => {
			if ( settleTimer.current ) {
				clearTimeout( settleTimer.current );
				settleTimer.current = null;
			}
		};
	}, [ ready, graph, serverLayout, storageKey, state.positions, state.key ] );

	// New, undropped nodes tuck below the left-most-then-bottom-most node.
	useEffect( () => {
		setState( ( prev ) => {
			// Guard a stale-scope run: skip until the reload commits this key.
			if ( prev.positions === null || prev.key !== storageKey ) {
				return prev;
			}
			const nodes = graph?.nodes ?? [];
			const positions = { ...prev.positions };
			const visible = visiblePositions( positions, nodes );
			let changed = false;
			for ( const n of nodes ) {
				if ( ! positions[ n.id ] ) {
					const pos = placeBelow( visible );
					positions[ n.id ] = pos;
					visible[ n.id ] = pos;
					changed = true;
				}
			}
			if ( ! changed ) {
				return prev;
			}
			// Externally-added node tucked is NOT a user mod — keep the flag.
			const next = {
				positions,
				viewport: prev.viewport,
				viewportDelta: prev.viewportDelta,
				modified: prev.modified,
				key: prev.key,
			};
			persist( storageKey, next );
			return next;
		} );
	}, [ graph, storageKey, state.key ] );

	const onPositionChange = useCallback(
		( id, pos ) => {
			setState( ( prev ) => {
				const next = {
					positions: {
						...( prev.positions || {} ),
						[ id ]: { x: pos.x, y: pos.y },
					},
					viewport: prev.viewport,
					viewportDelta: prev.viewportDelta,
					modified: true,
					key: prev.key,
				};
				persist( storageKey, next );
				return next;
			} );
		},
		[ storageKey ]
	);

	// Debounced 200ms: state keeps the viewBox, storage keeps the delta.
	const onViewportChange = useCallback(
		( vp, delta ) => {
			setState( ( prev ) => ( {
				...prev,
				viewport: vp,
				viewportDelta: delta,
			} ) );
			if ( vpTimer.current ) {
				clearTimeout( vpTimer.current );
			}
			vpTimer.current = setTimeout( () => {
				persist( storageKey, stateRef.current );
			}, 200 );
		},
		[ storageKey ]
	);

	// A rename moves no card, so `modified` stays as it was.
	const renamePosition = useCallback(
		( oldId, newId ) => {
			setState( ( prev ) => {
				if ( ! prev.positions || ! prev.positions[ oldId ] ) {
					return prev;
				}
				const positions = { ...prev.positions };
				positions[ newId ] = positions[ oldId ];
				delete positions[ oldId ];
				const next = { ...prev, positions };
				persist( storageKey, next );
				return next;
			} );
		},
		[ storageKey ]
	);

	// Surface the Reset Layout chip without moving anything (e.g. Reset Graph).
	const markDirty = useCallback( () => {
		setState( ( prev ) => {
			if ( prev.positions === null || prev.modified ) {
				return prev;
			}
			const next = { ...prev, modified: true };
			persist( storageKey, next );
			return next;
		} );
	}, [ storageKey ] );

	// Wipe the scope's storage; the init effect lays the graph out again.
	const resetLayout = useCallback( () => {
		if ( vpTimer.current ) {
			clearTimeout( vpTimer.current );
			vpTimer.current = null;
		}
		setState( { ...EMPTY, key: storageKey } );
		if ( ! storageKey ) {
			return;
		}
		try {
			window.localStorage.removeItem( storageKey );
		} catch ( _e ) {
			// localStorage disabled — in-session only.
		}
	}, [ storageKey ] );

	// Unmount drops a viewport write still inside the debounce window.
	useEffect(
		() => () => {
			if ( vpTimer.current ) {
				clearTimeout( vpTimer.current );
			}
		},
		[]
	);

	return {
		positions: state.positions || {},
		viewport: state.viewport,
		viewportDelta: state.viewportDelta,
		canReset: state.modified,
		onPositionChange,
		onViewportChange,
		renamePosition,
		markDirty,
		resetLayout,
	};
}

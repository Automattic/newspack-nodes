import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { autoLayout, placeBelow } from '../utils/autoLayout';

const EMPTY = { positions: null, viewport: null, modified: false };

function load( key ) {
	// A null key (e.g. an untitled draft) is in-memory only — never touch storage.
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
					? p.positions
					: null,
			viewport: p && p.viewport !== undefined ? p.viewport : null,
			modified: !! ( p && p.modified ),
			key,
		};
	} catch ( _e ) {
		return { ...EMPTY, key };
	}
}

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
				viewport: s.viewport,
				modified: s.modified,
			} )
		);
	} catch ( _e ) {
		// localStorage disabled / quota — in-session only.
	}
}

// Only on-screen nodes anchor placeBelow (stale map entries are ignored).
function visiblePositions( positions, nodes ) {
	const out = {};
	for ( const n of nodes ) {
		if ( positions[ n.id ] ) {
			out[ n.id ] = positions[ n.id ];
		}
	}
	return out;
}

/**
 * The canvas position map: built once (autoLayout / server layout) when the
 * complete graph is ready, then mutated only by drags, drops, and new-node
 * tucks. autoLayout never re-runs except via resetLayout.
 *
 * @param {Object}  opts
 * @param {string}  opts.storageKey     localStorage key (scope-scoped).
 * @param {Object}  opts.graph          { nodes, edges } — the COMPLETE graph for the scope.
 * @param {boolean} opts.ready          Graph fully built (and server fetch resolved for worker scopes).
 * @param {Object}  [opts.serverLayout] Worker-topology saved layout, or null.
 * @return {Object} { positions, viewport, canReset, onPositionChange, onViewportChange, renamePosition, resetLayout }.
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

	// Reload on scope switch; cancel any pending viewport write.
	useEffect( () => {
		if ( vpTimer.current ) {
			clearTimeout( vpTimer.current );
			vpTimer.current = null;
		}
		setState( load( storageKey ) );
	}, [ storageKey ] );

	// One-shot init: autoLayout once (or adopt server layout) when ready + uninitialized.
	// Functional update + the `prev.key !== storageKey` guard (symmetric with the tuck
	// effect below) so a concurrent key-change reload wins the race: on a key switch
	// the reload commits the loaded positions first, and this re-checks `prev` instead
	// of clobbering them with autoLayout off a stale (null) closure snapshot.
	useEffect( () => {
		if ( ! ready ) {
			return;
		}
		const nodes = graph?.nodes ?? [];
		if ( nodes.length === 0 ) {
			return;
		}
		setState( ( prev ) => {
			if ( prev.positions !== null || prev.key !== storageKey ) {
				return prev;
			}
			let positions;
			if ( serverLayout && Object.keys( serverLayout ).length > 0 ) {
				positions = { ...serverLayout };
				for ( const n of nodes ) {
					if ( ! positions[ n.id ] ) {
						positions[ n.id ] = placeBelow(
							visiblePositions( positions, nodes )
						);
					}
				}
			} else {
				positions = {};
				for ( const n of autoLayout( graph ).nodes ) {
					positions[ n.id ] = n.position;
				}
			}
			const next = {
				positions,
				viewport: prev.viewport,
				modified: false,
				key: storageKey,
			};
			persist( storageKey, next );
			return next;
		} );
	}, [
		ready,
		graph,
		serverLayout,
		storageKey,
		state.positions,
		state.viewport,
	] );

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
			// Auto-placing a node that appeared is NOT a user modification — the
			// graph can change from outside this console (the shared Core gains
			// nodes when another view/tab mounts). Preserve the modified flag so
			// "Reset Layout" only surfaces when the USER moved/renamed something,
			// not whenever an external node gets tucked in.
			const next = {
				positions,
				viewport: prev.viewport,
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
					modified: true,
					key: prev.key,
				};
				persist( storageKey, next );
				return next;
			} );
		},
		[ storageKey ]
	);

	const onViewportChange = useCallback(
		( vp ) => {
			setState( ( prev ) => ( { ...prev, viewport: vp } ) );
			if ( vpTimer.current ) {
				clearTimeout( vpTimer.current );
			}
			vpTimer.current = setTimeout( () => {
				persist( storageKey, stateRef.current );
			}, 200 );
		},
		[ storageKey ]
	);

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

	// Surface the Reset Layout chip without moving anything — e.g. after Reset Graph.
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
		canReset: state.modified,
		onPositionChange,
		onViewportChange,
		renamePosition,
		markDirty,
		resetLayout,
	};
}

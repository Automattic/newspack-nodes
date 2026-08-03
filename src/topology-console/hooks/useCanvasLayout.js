import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { autoLayout, placeBelow } from '../utils/autoLayout';

const EMPTY = {
	positions: null,
	viewport: null,
	viewportDelta: null,
	modified: false,
};

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
			// Start null; the freeze re-derives the live viewBox from delta.
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

// @longform
// Storage is not trusted input: a NaN coordinate serializes to null, and a
// stored one outlives the bug that wrote it — `modified` makes the browser
// copy beat the server layout, and the one-shot init skips a non-null map,
// so the card stays off-graph. Drop the bad ones; the tuck re-places them.
function sanitizePositions( positions ) {
	const clean = {};
	for ( const [ id, position ] of Object.entries( positions ) ) {
		if ( isPosition( position ) ) {
			clean[ id ] = position;
		}
	}
	return clean;
}

function isPosition( value ) {
	return (
		value !== null &&
		typeof value === 'object' &&
		Number.isFinite( value.x ) &&
		Number.isFinite( value.y )
	);
}

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
 * The canvas position map: built once (autoLayout / server layout) when the
 * complete graph is ready, then reconciled with a late server layout or mutated
 * by drags, drops, and new-node tucks. autoLayout never re-runs except via
 * resetLayout.
 *
 * @param {Object}  opts
 * @param {string}  opts.storageKey     localStorage key (scope-scoped).
 * @param {Object}  opts.graph          { nodes, edges } — the COMPLETE graph for the scope.
 * @param {boolean} opts.ready          Graph fully built (and server fetch resolved for worker scopes).
 * @param {Object}  [opts.serverLayout] Worker-topology saved layout, or null.
 * @return {Object} { positions, viewport, canReset, onPositionChange, onViewportChange, renamePosition, resetLayout }.
 */
// Wait this long for the streamed node set to settle before one-shot layout.
const LAYOUT_SETTLE_MS = 250;

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
		viewportDelta: state.viewportDelta,
		canReset: state.modified,
		onPositionChange,
		onViewportChange,
		renamePosition,
		markDirty,
		resetLayout,
	};
}

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { autoLayout, placeBelow } from '../utils/autoLayout';

const EMPTY = { positions: null, viewport: null, modified: false };

function load( key ) {
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
	useEffect( () => {
		if ( ! ready || state.positions !== null ) {
			return;
		}
		const nodes = graph?.nodes ?? [];
		if ( nodes.length === 0 ) {
			return;
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
			viewport: state.viewport,
			modified: false,
			key: storageKey,
		};
		persist( storageKey, next );
		setState( next );
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
			const next = {
				positions,
				viewport: prev.viewport,
				modified: true,
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

	const resetLayout = useCallback( () => {
		if ( vpTimer.current ) {
			clearTimeout( vpTimer.current );
			vpTimer.current = null;
		}
		setState( { ...EMPTY, key: storageKey } );
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
		resetLayout,
	};
}

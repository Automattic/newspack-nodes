import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

function loadPositions( key ) {
	try {
		const raw = window.localStorage.getItem( key );
		return raw ? JSON.parse( raw ) : {};
	} catch ( _e ) {
		return {};
	}
}

function loadViewport( key ) {
	try {
		const raw = window.localStorage.getItem( key );
		return raw ? JSON.parse( raw ) : null;
	} catch ( _e ) {
		return null;
	}
}

/**
 * Per-dashboard layout state for the overlay: node-position overrides + the
 * canvas viewport, both localStorage-backed. Without it the canvas can't pan,
 * zoom, or remember a node drag — the SchematicCanvas is controlled-state, so
 * a no-op `onPositionChange`/missing `onViewportChange` makes every render
 * snap layout back to defaults. Viewport writes debounce 200ms (a pan-drag
 * fires onViewportChange at ~60fps).
 *
 * Reloads positions + viewport when `storageKey` changes — callers scope it
 * to the current cwd (e.g. `newspack-nodes:debug:_http`) so / and /_http
 * don't fight over canvas coordinates.
 *
 * @param {string} storageKey Persistence key (the overlay's storageKey prop).
 * @return {Object} { positions, viewport, onPositionChange, onViewportChange }.
 */
export function useDebugLayout( storageKey ) {
	const positionsKey = `${ storageKey }:positions`;
	const viewportKey = `${ storageKey }:viewport`;

	const [ positions, setPositions ] = useState( () =>
		loadPositions( positionsKey )
	);
	const [ viewport, setViewport ] = useState( () =>
		loadViewport( viewportKey )
	);
	const viewportSaveTimer = useRef( null );

	// Re-load on storageKey change (cwd switch) — useState's lazy init only
	// fires once, so a key change otherwise leaves us with stale state from
	// the prior scope. Also clear any pending viewport debounce so a panA
	// scheduled at t=0 in scope A doesn't fire (cancelled or write-to-old-key)
	// after a t=100 cd to scope B.
	useEffect( () => {
		if ( viewportSaveTimer.current ) {
			clearTimeout( viewportSaveTimer.current );
			viewportSaveTimer.current = null;
		}
		setPositions( loadPositions( positionsKey ) );
		setViewport( loadViewport( viewportKey ) );
	}, [ positionsKey, viewportKey ] );

	const onPositionChange = useCallback(
		( nodeId, pos ) => {
			setPositions( ( prev ) => {
				const next = { ...prev, [ nodeId ]: { x: pos.x, y: pos.y } };
				try {
					window.localStorage.setItem(
						positionsKey,
						JSON.stringify( next )
					);
				} catch ( _e ) {
					// localStorage disabled — in-session only.
				}
				return next;
			} );
		},
		[ positionsKey ]
	);

	const onViewportChange = useCallback(
		( next ) => {
			setViewport( next );
			if ( viewportSaveTimer.current ) {
				clearTimeout( viewportSaveTimer.current );
			}
			viewportSaveTimer.current = setTimeout( () => {
				try {
					if ( next === null ) {
						window.localStorage.removeItem( viewportKey );
					} else {
						window.localStorage.setItem(
							viewportKey,
							JSON.stringify( next )
						);
					}
				} catch ( _e ) {
					// localStorage disabled — in-session only.
				}
			}, 200 );
		},
		[ viewportKey ]
	);

	// Clear the debounce timer on unmount so a pending write doesn't fire late.
	useEffect( () => {
		return () => {
			if ( viewportSaveTimer.current ) {
				clearTimeout( viewportSaveTimer.current );
			}
		};
	}, [] );

	const resetLayout = useCallback( () => {
		setPositions( {} );
		setViewport( null );
		try {
			window.localStorage.removeItem( positionsKey );
			window.localStorage.removeItem( viewportKey );
		} catch ( _e ) {
			// localStorage disabled — in-session only.
		}
	}, [ positionsKey, viewportKey ] );

	return {
		positions,
		viewport,
		onPositionChange,
		onViewportChange,
		resetLayout,
	};
}

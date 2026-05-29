import { useCallback, useEffect, useRef, useState } from '@wordpress/element';

const DEFAULT_STATE = { positions: {}, viewport: null, dirty: false };

function loadLayout( key ) {
	try {
		const raw = window.localStorage.getItem( key );
		if ( ! raw ) {
			return { ...DEFAULT_STATE };
		}
		const parsed = JSON.parse( raw );
		// Tolerate older / partial entries — coerce missing fields to defaults.
		return {
			positions:
				parsed &&
				typeof parsed.positions === 'object' &&
				parsed.positions
					? parsed.positions
					: {},
			viewport:
				parsed && parsed.viewport !== undefined
					? parsed.viewport
					: null,
			dirty: !! ( parsed && parsed.dirty ),
		};
	} catch ( _e ) {
		return { ...DEFAULT_STATE };
	}
}

function persist( key, state ) {
	try {
		window.localStorage.setItem( key, JSON.stringify( state ) );
	} catch ( _e ) {
		// localStorage disabled / quota exceeded — in-session only.
	}
}

/**
 * Per-dashboard layout state for the overlay/console — single localStorage
 * entry at `storageKey` shaped `{ positions, viewport, dirty }`.
 *
 * - If localStorage has an entry: use it.
 * - If not: the canvas computes a layout via autoLayout and calls
 *   `onSeedLayout(positionsMap)`; the hook persists it with `dirty: false`.
 * - Any user modification (`onPositionChange`, `onViewportChange`) flips
 *   `dirty: true`. `isDirty` is what the UI gates the "Reset Layout" button on.
 * - `resetLayout()` removes the entry; the next paint re-seeds via the canvas.
 *
 * Viewport writes debounce 200ms (a pan-drag fires onViewportChange at ~60fps).
 * Reloads on `storageKey` change — callers scope it to the current cwd (e.g.
 * `newspack-nodes:debug:_http`) so / and /_http don't share canvas coordinates.
 *
 * @param {string} storageKey Persistence key (the overlay's storageKey prop).
 * @return {Object} { positions, viewport, isDirty, onPositionChange,
 *                    onViewportChange, onSeedLayout, resetLayout }.
 */
export function useDebugLayout( storageKey ) {
	const [ state, setState ] = useState( () => loadLayout( storageKey ) );
	const viewportSaveTimer = useRef( null );
	// Mirror of `state` for the debounced viewport write — setState's prev-arg
	// is unavailable inside a setTimeout, and we need the current positions
	// and dirty flag to land in the persisted entry alongside the viewport.
	const stateRef = useRef( state );
	stateRef.current = state;

	// Re-load on storageKey change (cwd switch). useState's lazy init only
	// fires once; without this, a key change leaves stale state from the
	// prior scope. Also cancel any pending viewport debounce so a write
	// scheduled in scope A doesn't land in scope B.
	useEffect( () => {
		if ( viewportSaveTimer.current ) {
			clearTimeout( viewportSaveTimer.current );
			viewportSaveTimer.current = null;
		}
		setState( loadLayout( storageKey ) );
	}, [ storageKey ] );

	const onPositionChange = useCallback(
		( nodeId, pos ) => {
			setState( ( prev ) => {
				const next = {
					positions: {
						...prev.positions,
						[ nodeId ]: { x: pos.x, y: pos.y },
					},
					viewport: prev.viewport,
					dirty: true,
				};
				persist( storageKey, next );
				return next;
			} );
		},
		[ storageKey ]
	);

	// Pan/zoom is NOT a layout modification — dirty stays whatever it was.
	// (Only `onPositionChange` flips dirty.) The canvas's autofit-on-mount
	// effect commits a viewport back to the parent immediately after we set
	// it to null; if that flipped dirty, "Reset Layout" would reappear right
	// after the user clicked it.
	const onViewportChange = useCallback(
		( next ) => {
			setState( ( prev ) => ( {
				positions: prev.positions,
				viewport: next,
				dirty: prev.dirty,
			} ) );
			if ( viewportSaveTimer.current ) {
				clearTimeout( viewportSaveTimer.current );
			}
			viewportSaveTimer.current = setTimeout( () => {
				persist( storageKey, stateRef.current );
			}, 200 );
		},
		[ storageKey ]
	);

	// Seeded layout sticks (dirty=false) — re-rendering the canvas re-fires
	// the seed effect, so this must be idempotent. Skip when the user has
	// already touched anything (dirty), when positions is already populated
	// (already seeded), or when the seed itself is empty (no graph yet).
	const onSeedLayout = useCallback(
		( positionsMap ) => {
			setState( ( prev ) => {
				if ( prev.dirty ) {
					return prev;
				}
				if ( Object.keys( prev.positions ).length > 0 ) {
					return prev;
				}
				if (
					! positionsMap ||
					Object.keys( positionsMap ).length === 0
				) {
					return prev;
				}
				// Force the canvas to re-autofit to the just-seeded positions:
				// after a reset → reseed, the canvas's autofit-on-mount effect
				// may have already committed a viewport based on the pre-seed
				// (intermediate autoLayout) positions. Clearing viewport here
				// re-fires that effect with the seeded nodes.
				const next = {
					positions: { ...positionsMap },
					viewport: null,
					dirty: false,
				};
				persist( storageKey, next );
				return next;
			} );
		},
		[ storageKey ]
	);

	// Move an entry from oldId to newId — for rename flows where the underlying
	// node identity is preserved. Dirty-neutral: a rename isn't a user-driven
	// position change.
	const renamePosition = useCallback(
		( oldId, newId ) => {
			setState( ( prev ) => {
				if ( ! prev.positions[ oldId ] ) {
					return prev;
				}
				const positions = { ...prev.positions };
				positions[ newId ] = positions[ oldId ];
				delete positions[ oldId ];
				const next = {
					positions,
					viewport: prev.viewport,
					dirty: prev.dirty,
				};
				persist( storageKey, next );
				return next;
			} );
		},
		[ storageKey ]
	);

	// Cancel the debounce on unmount so a pending write doesn't fire late.
	useEffect( () => {
		return () => {
			if ( viewportSaveTimer.current ) {
				clearTimeout( viewportSaveTimer.current );
			}
		};
	}, [] );

	const resetLayout = useCallback( () => {
		if ( viewportSaveTimer.current ) {
			clearTimeout( viewportSaveTimer.current );
			viewportSaveTimer.current = null;
		}
		setState( { ...DEFAULT_STATE } );
		try {
			window.localStorage.removeItem( storageKey );
		} catch ( _e ) {
			// localStorage disabled — in-session only.
		}
	}, [ storageKey ] );

	return {
		positions: state.positions,
		viewport: state.viewport,
		isDirty: state.dirty,
		onPositionChange,
		onViewportChange,
		onSeedLayout,
		renamePosition,
		resetLayout,
	};
}

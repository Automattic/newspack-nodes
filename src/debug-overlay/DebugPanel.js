import { useEffect, useCallback, useRef } from '@wordpress/element';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import { lockPageScroll, unlockPageScroll } from './pageScrollLock';
import { useDebugFrame } from './useDebugFrame';

/**
 * The overlay's panel — a thin tab host. It owns the floating-window concerns
 * (draggable/resizable frame via useDebugFrame, the wheel eater, the
 * page-scroll lock, the resize handles) and a tab bar driven by
 * getDevtoolsTabs('overlay'). It lazy-mounts ONLY the selected tab; the body
 * itself (the live-graph inspector + REPL) lives in InspectorTab, reached
 * through the registry. The `key={ active.id }` forces unmount/remount on tab
 * switch so each tab's build-before-render runs fresh.
 *
 * Mounted by DebugOverlay ONLY while open, so the active tab's graph-building
 * hooks construct their infra BEFORE the subtree's first render; closing the
 * panel unmounts this component and tears that infra down.
 *
 * @param {Object}   props
 * @param {string}   props.storageKey Layout persistence key (per dashboard).
 * @param {Function} props.onClose    Close the panel (parent's setOpen(false)).
 * @return {import('react').ReactElement} The panel.
 */
export default function DebugPanel( { storageKey, onClose } ) {
	const {
		frame,
		style: frameStyle,
		onHeaderPointerDown,
		getResizeHandlers,
		toggleMaximize,
		maximized,
		// Global frame key — same overlay dimensions across every dashboard.
	} = useDebugFrame( 'newspack-nodes:debug:frame', true );

	const panelRef = useRef( null );

	// Eat wheel scrolls inside the panel so they don't scroll the page behind the
	// overlay. preventDefault needs a non-passive listener — attach one directly.
	useEffect( () => {
		const el = panelRef.current;
		if ( ! el ) {
			return undefined;
		}
		const consumedByInnerScroll = ( target, deltaY ) => {
			let node = target;
			while ( node && node !== el ) {
				if ( node.scrollHeight > node.clientHeight ) {
					const oy = window.getComputedStyle( node ).overflowY;
					if ( 'auto' === oy || 'scroll' === oy ) {
						const atTop = node.scrollTop <= 0;
						const atBottom =
							node.scrollTop + node.clientHeight >=
							node.scrollHeight - 1;
						if (
							( deltaY < 0 && ! atTop ) ||
							( deltaY > 0 && ! atBottom )
						) {
							return true;
						}
					}
				}
				node = node.parentNode;
			}
			return false;
		};
		const onWheel = ( e ) => {
			if ( ! consumedByInnerScroll( e.target, e.deltaY ) ) {
				e.preventDefault();
			}
		};
		el.addEventListener( 'wheel', onWheel, { passive: false } );
		return () => el.removeEventListener( 'wheel', onWheel );
	}, [] );

	// Callback ref for the panel: tracks the node AND releases the page-scroll
	// lock the instant the panel detaches (close, unmount, or remount).
	const setPanelRef = useCallback( ( node ) => {
		panelRef.current = node;
		if ( ! node ) {
			unlockPageScroll();
		}
	}, [] );

	return (
		<div
			ref={ setPanelRef }
			className={ `nodes-debug__panel${
				maximized ? ' is-maximized' : ''
			}` }
			data-testid="debug-panel"
			style={ frameStyle }
			// Block the page behind the overlay from scrolling whenever the
			// pointer is inside the panel (Safari ignores the canvas wheel's
			// preventDefault, so pin the page physically instead).
			onPointerEnter={ lockPageScroll }
			onPointerLeave={ unlockPageScroll }
		>
			<DevtoolsTabHost
				host="overlay"
				tabProps={ {
					storageKey,
					onClose,
					frame,
					onHeaderPointerDown,
					toggleMaximize,
				} }
			/>
			{ Object.entries( getResizeHandlers() ).map( ( [ key, h ] ) => (
				<div
					key={ key }
					className={ `nodes-debug__resize nodes-debug__resize--${ key }` }
					onPointerDown={ h.onPointerDown }
				/>
			) ) }
		</div>
	);
}

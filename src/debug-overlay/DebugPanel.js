import { useEffect, useCallback, useRef, useState } from '@wordpress/element';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import Header from '../topology-console/components/Header';
import { useThemeValue } from '@newspack-nodes/shared/useTheme';
import { lockPageScroll, unlockPageScroll } from './pageScrollLock';
import { useDebugFrame } from './useDebugFrame';

/**
 * The overlay's panel. It owns the floating-window concerns (draggable/resizable
 * frame via useDebugFrame, the wheel eater, the page-scroll lock, the resize
 * handles) AND the ONE shared header: the topology-console Header is rendered
 * here, once, above the tab bar — so every tab sits under the SAME header (same
 * height, same place) instead of each tab duplicating its own. The active tab
 * publishes any header extras it wants (the Console publishes its cwd PATH
 * selector) up via `publishHeader`; the body itself (Console graph+REPL, or the
 * I/O Overview) is header-less and lives in its tab component.
 *
 * Mounted by DebugOverlay ONLY while open, so the active tab's graph-building
 * hooks construct their infra BEFORE the subtree's first render; closing the
 * panel unmounts this component and tears that infra down.
 *
 * @param {Object}   props
 * @param {string}   props.storageKey  Layout persistence key (per dashboard).
 * @param {Function} props.onClose     Close the panel (parent's setOpen(false)).
 * @param {boolean}  [props.buildRepl] When false (Console tab), the Inspector tab runs Overview-only.
 * @return {import('react').ReactElement} The panel.
 */
export default function DebugPanel( {
	storageKey,
	onClose,
	buildRepl = true,
} ) {
	// The panel element ref, created BEFORE the frame hook so the hook can mutate
	// its style directly during a drag/resize (no per-frame React re-render).
	const panelRef = useRef( null );

	const {
		frame,
		style: frameStyle,
		onHeaderPointerDown,
		getResizeHandlers,
		toggleMaximize,
		maximized,
		// Global frame key — same overlay dimensions across every dashboard.
	} = useDebugFrame( 'newspack-nodes:debug:frame', true, panelRef );

	// The active tab publishes the header controls it owns (the Console its PATH
	// selector; the Overview nothing). Merged into the one shared Header below.
	const [ headerExtras, setHeaderExtras ] = useState( null );
	// Theme drives the whole panel's token context (the chrome reads --paper /
	// --ink, NOT fixed --np-* tokens). Read from the shared reactive store, so a
	// `set_skin` (from this panel's Console, or anywhere) re-skins the panel
	// chrome AND the console body in the SAME commit — no lagging publish-up.
	const theme = useThemeValue();

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
		// display:contents themed token-provider wrapping the WHOLE panel: the
		// panel + header + tab bar become descendants of `.topology-app.theme-<x>`
		// so every chrome rule resolves the theme's --paper/--ink/etc. (not fixed
		// --np-* tokens). No box, so the panel's own fixed positioning is intact.
		<div
			className={ `topology-app newspack-nodes-theme theme-${ theme }` }
			style={ { display: 'contents' } }
		>
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
				{ /* The ONE shared header — `.topology-header` is the panel's
				     direct flex child, identical for every tab. */ }
				<div
					className="nodes-debug__header-drag"
					data-testid="overlay-header"
					onPointerDown={ onHeaderPointerDown }
					onDoubleClick={ ( e ) => {
						const tag = e.target?.tagName;
						if (
							tag === 'SELECT' ||
							tag === 'BUTTON' ||
							tag === 'INPUT' ||
							tag === 'OPTION' ||
							e.target?.closest?.( 'select, button, input' )
						) {
							return;
						}
						toggleMaximize();
					} }
				>
					<Header
						mode="view"
						onClose={ onClose }
						{ ...headerExtras }
					/>
				</div>
				<DevtoolsTabHost
					host="overlay"
					tabProps={ {
						storageKey,
						frame,
						publishHeader: setHeaderExtras,
						buildRepl,
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
		</div>
	);
}

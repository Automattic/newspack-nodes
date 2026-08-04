import { useEffect, useCallback, useRef, useState } from '@wordpress/element';
import DevtoolsTabHost from '@newspack-nodes/shared/devtools/DevtoolsTabHost';
import Header from '../topology-console/components/Header';
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
	// Panel ref created before the frame hook so it mutates style on drag.
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

	// The active tab publishes the header controls it owns; merged into Header.
	const [ headerExtras, setHeaderExtras ] = useState( null );

	// Eat wheel scrolls inside the panel (non-passive, preventDefault).
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

	// Callback ref: track the node AND release the page-scroll lock on detach.
	const setPanelRef = useCallback( ( node ) => {
		panelRef.current = node;
		if ( ! node ) {
			unlockPageScroll();
		}
	}, [] );

	return (
		<div style={ { display: 'contents' } }>
			<div
				ref={ setPanelRef }
				className={ `nodes-debug__panel${
					maximized ? ' is-maximized' : ''
				}` }
				data-testid="debug-panel"
				style={ frameStyle }
				// Pin page while pointer inside (Safari ignores wheel PD).
				onPointerEnter={ lockPageScroll }
				onPointerLeave={ unlockPageScroll }
			>
				{ /* The ONE shared header, identical for every tab. */ }
				<div
					className="nodes-debug__header-drag"
					data-testid="overlay-header"
					onPointerDown={ onHeaderPointerDown }
					onDoubleClick={ ( e ) => {
						const el = /** @type {HTMLElement} */ ( e.target );
						const tag = el?.tagName;
						if (
							tag === 'SELECT' ||
							tag === 'BUTTON' ||
							tag === 'INPUT' ||
							tag === 'OPTION' ||
							el?.closest?.( 'select, button, input' )
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

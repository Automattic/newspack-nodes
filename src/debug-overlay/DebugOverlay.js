import { useCallback, useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { initSkin } from '@newspack-nodes/shared/theme';
import { isDebugEnabled } from './isDebugEnabled';
import DebugPanel from './DebugPanel';
import { startOverviewSampler, stopOverviewSampler } from './overviewSampler';
import './tabs'; // registers the built-in overlay tabs (Overview, Console)
import './debug-overlay.scss';

/**
 * Same-page debug overlay: a debug-gated floating launcher and panel that put
 * the host page's own live `Core.nodes` graph on top of whatever dashboard is
 * running. The panel hosts the registered `overlay` tabs — Overview (this
 * browser's I/O rates) and Console (the graph in the shared GraphView, plus a
 * REPL that pokes it through the page's own CommandInterpreter).
 *
 * `?nodes-debug=1` opens the gate and sticks; Ctrl+` then toggles the panel.
 * Disabled, the overlay renders nothing and samples nothing. Enabled, the
 * Overview sampler runs whether the panel is open or shut, so the rate charts
 * already carry history when you open it.
 *
 * The panel mounts ONLY while open. That is what lets the active tab's graph
 * hooks build their nodes in `useState` lazy initializers, ahead of the
 * subtree's first render: `shell.sink` is bound during the build, before any
 * typed line can dispatch, so nothing has to resolve a sink at dispatch time.
 *
 * The root div carries the skin provider classes only when no ancestor is
 * already a `.newspack-nodes-ui`. Standalone, the overlay supplies the skin
 * itself; inside a dashboard shell it inherits the host's, leaving one
 * provider root in the tree. Only the DOM answers that, so the state starts as
 * owner and steps down when the ref callback finds a provider above.
 *
 * @param {Object}  props
 * @param {string}  [props.search]     `window.location.search` the gate reads; tests inject it.
 * @param {string}  [props.storageKey] Canvas-layout localStorage key, per dashboard so node positions never collide. The panel's frame geometry is global and ignores it.
 * @param {boolean} [props.buildRepl]  When false the Console tab builds no graph or REPL infra and points at the page's own console; Overview is unaffected.
 * @return {import('react').ReactElement|null} The overlay, or null when debug is disabled.
 */
export default function DebugOverlay( {
	search,
	storageKey = 'newspack-nodes:debug',
	// false on hub Console tab — its graph+REPL would collide with Console's.
	buildRepl = true,
} ) {
	const enabled = isDebugEnabled( search );
	const [ open, setOpen ] = useState( false );
	const [ ownsProvider, setOwnsProvider ] = useState( true );
	// Own the skin provider only when no ancestor already is one.
	const setRootRef = useCallback( ( node ) => {
		if ( node ) {
			setOwnsProvider(
				! node.parentElement?.closest( '.newspack-nodes-ui' )
			);
		}
	}, [] );

	// Apply the persisted <html> skin so this surface matches the console pick.
	useEffect( () => {
		if ( enabled ) {
			initSkin();
		}
	}, [ enabled ] );

	// Ctrl+` toggles the panel while enabled.
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		const onKey = ( e ) => {
			if ( e.ctrlKey && e.key === '`' ) {
				e.preventDefault();
				setOpen( ( v ) => ! v );
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ enabled ] );

	// Keep the Overview sampler running while enabled for continuous history.
	useEffect( () => {
		if ( ! enabled ) {
			return undefined;
		}
		startOverviewSampler();
		return stopOverviewSampler;
	}, [ enabled ] );

	if ( ! enabled ) {
		return null;
	}

	return (
		<div
			ref={ setRootRef }
			className={ `nodes-debug${
				ownsProvider
					? ' newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
					: ''
			}` }
		>
			{ ! open && (
				<button
					type="button"
					className="nodes-debug__fab"
					aria-label={ __(
						'Toggle node debugger',
						'newspack-nodes'
					) }
					onClick={ () => setOpen( ( v ) => ! v ) }
				>
					{ '◉' }
				</button>
			) }
			{ open && (
				<DebugPanel
					storageKey={ storageKey }
					buildRepl={ buildRepl }
					onClose={ () => setOpen( false ) }
				/>
			) }
		</div>
	);
}

import { useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { isDebugEnabled } from './isDebugEnabled';
import DebugPanel from './DebugPanel';
import { startOverviewSampler, stopOverviewSampler } from './overviewSampler';
import './tabs'; // registers the built-in overlay tabs (Inspector, Overview)
import './debug-overlay.scss';

// (We reuse the topology console's CanvasFrame directly for visual parity —
// reticles, paper background, "kissing the header" border seal — and pass
// only the minimal props it needs. No PlainFrame.)

/**
 * Same-page debug overlay: a debug-gated floating FAB + panel that renders the
 * host page's own live Core.nodes graph in the shared GraphView and lets you
 * poke it (connect/remove/invoke) via the page's own CommandInterpreter.
 *
 * The panel (DebugPanel) mounts ONLY while open, so it builds its graph BEFORE
 * its first render (useState lazy-initializer in the graph hooks) — never in a
 * render-effect. That build-before-render is what dissolves the old open-and-type
 * shell.sink race: shell.sink is bound during the build, before any typed line
 * can dispatch, so there is no dispatch-time resolve.
 *
 * Reset Graph (inside the panel) rebuilds the ENTIRE graph in place: it removes
 * every node, then bumps `Core.graphGeneration` so every graph-building effect
 * (each dashboard's mountExospine + this overlay's useDebugRepl) tears down and
 * rebuilds its nodes fresh.
 *
 * @param {Object}  props
 * @param {string}  [props.search]     Injectable location.search (tests).
 * @param {string}  [props.storageKey] Layout persistence key (per dashboard).
 * @param {boolean} [props.buildRepl]  When false (hub Console tab), the Inspector body runs Overview-only.
 * @return {import('react').ReactElement|null} The overlay, or null when debug is disabled.
 */
export default function DebugOverlay( {
	search,
	storageKey = 'newspack-nodes:debug',
	// false on the hub Console tab — the overlay's own graph+REPL would collide
	// with the Console's shared infra, so the Inspector body runs Overview-only.
	buildRepl = true,
} ) {
	const enabled = isDebugEnabled( search );
	const [ open, setOpen ] = useState( false );

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

	// Keep the always-on Overview sampler running for the whole time the overlay
	// is enabled — independent of the panel being open or the Overview tab being
	// selected — so the rate charts carry continuous history.
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
		<div className="nodes-debug">
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

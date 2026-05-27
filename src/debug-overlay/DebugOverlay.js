import { useCallback, useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import GraphView from '../topology-console/components/GraphView';
import { isDebugEnabled } from './isDebugEnabled';
import { useDebugGraph } from './useDebugGraph';
import './debug-overlay.scss';

// Minimal canvas frame for the overlay — no topology/layout chrome.
const PlainFrame = ( { children } ) => (
	<div className="nodes-debug__canvas">{ children }</div>
);

/**
 * Same-page debug overlay: a debug-gated floating FAB + panel that renders the
 * host page's own live Core.nodes graph in the shared GraphView and lets you
 * poke it (connect/remove/invoke) via the page's own CommandInterpreter.
 *
 * @param {Object} props
 * @param {string} [props.search]     Injectable location.search (tests).
 * @param {string} [props.storageKey] Layout persistence key (per dashboard).
 * @return {import('react').ReactElement|null} The overlay, or null when debug is disabled.
 */
export default function DebugOverlay( {
	search,
	storageKey = 'newspack-nodes:debug',
} ) {
	const enabled = isDebugEnabled( search );
	const [ open, setOpen ] = useState( false );
	const [ selected, setSelected ] = useState( null );
	const { graph, handlers } = useDebugGraph( enabled && open );

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

	// Local-only; layout persistence is a fast-follow.
	const onPositionChange = useCallback( () => {}, [] );

	if ( ! enabled ) {
		return null;
	}

	return (
		<div className="nodes-debug">
			<button
				type="button"
				className="nodes-debug__fab"
				aria-label={ __( 'Toggle node debugger', 'newspack-nodes' ) }
				onClick={ () => setOpen( ( v ) => ! v ) }
			>
				{ '◉' }
			</button>
			{ open && (
				<div className="nodes-debug__panel" data-testid="debug-panel">
					<div
						className={ `topology-app theme-current${
							selected ? ' is-inspector-open' : ''
						}` }
					>
						<GraphView
							graph={ graph }
							frame={ PlainFrame }
							resetKey={ storageKey }
							interactive
							editMode={ false }
							showPalette={ false }
							onConnect={ handlers.onConnect }
							onRemoveNode={ handlers.onRemoveNode }
							onInspectorAction={ handlers.onInspectorAction }
							onPositionChange={ onPositionChange }
							onSelectionChange={ setSelected }
						/>
					</div>
				</div>
			) }
		</div>
	);
}

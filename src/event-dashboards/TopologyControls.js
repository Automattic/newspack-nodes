/**
 * TopologyControls — the per-topology action cluster (active toggle + fleet
 * restart + Edit deep-link) shared by the Topologies and Overview hub tabs, so
 * both carry the SAME controls with one set of styles. A rejected mutation is
 * surfaced via `onError` (never swallowed, never crashes the render).
 */

import { __ } from '@wordpress/i18n';

/**
 * @param {Object}   props
 * @param {string}   props.name         Topology name (the mutation argument).
 * @param {boolean}  props.active       Whether the topology is active.
 * @param {Function} props.onActivate   (name) => Promise.
 * @param {Function} props.onDeactivate (name) => Promise.
 * @param {Function} props.onRestart    (name) => Promise.
 * @param {Function} props.onError      ({name,message}) => void for a rejected mutation.
 * @param {string}   props.editHref     Console edit deep-link.
 * @return {import('react').ReactElement} The control cluster.
 */
export default function TopologyControls( {
	name,
	active,
	onActivate,
	onDeactivate,
	onRestart,
	onError,
	editHref,
} ) {
	const fire = ( fn ) => () =>
		Promise.resolve( fn( name ) ).catch( ( err ) =>
			onError?.( { name, message: err?.message || String( err ) } )
		);

	return (
		<span className="nodes-ctl">
			<button
				type="button"
				role="switch"
				aria-checked={ active }
				className="button button-small nodes-ctl__toggle"
				title={
					active
						? __( 'Deactivate', 'newspack-nodes' )
						: __( 'Activate', 'newspack-nodes' )
				}
				onClick={ fire( active ? onDeactivate : onActivate ) }
			/>
			{ active && (
				<button
					type="button"
					className="nodes-ctl__restart button button-small"
					title={ __( 'Restart fleet', 'newspack-nodes' ) }
					onClick={ fire( onRestart ) }
				>
					↻
				</button>
			) }
			<a
				className="nodes-ctl__edit button button-small"
				href={ editHref }
				title={ __(
					'Edit this topology in the console',
					'newspack-nodes'
				) }
			>
				{ __( 'Edit', 'newspack-nodes' ) }
			</a>
		</span>
	);
}

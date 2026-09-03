/**
 * TopologyControls — the per-topology action cluster: an activation toggle, a
 * fleet restart and an Edit deep-link into the Console. The Overview tab
 * renders it in two places, on each active topology's `TopologyRow` heading and
 * on each stopped topology's chip, so both carry the SAME controls under one
 * set of styles.
 *
 * Each action fires and returns. `useTopologyManager` mints the command, and
 * its reply comes back addressed to that node (TO=FROM, ADR-7) rather than as a
 * return value (ADR-13); a refusal surfaces through the hook's `onError`. There
 * is nothing here to await, and so nothing to swallow.
 *
 * The toggle carries no label because `role="switch"` and `aria-checked` are
 * the style hooks as well as the semantics: shared `_buttons.scss` paints the
 * track from the button and the knob from its `::after`. The empty body is
 * deliberate.
 */

import { __ } from '@wordpress/i18n';

/**
 * Render one topology's control cluster.
 *
 * Restart appears only while the topology is active, because a stopped fleet
 * has no workers to restart.
 *
 * @param {Object}   props
 * @param {string}   props.name         Topology name; every handler receives it.
 * @param {boolean}  props.active       Whether the topology is active.
 * @param {Function} props.onActivate   Activate the topology.
 * @param {Function} props.onDeactivate Deactivate the topology.
 * @param {Function} props.onRestart    Restart the topology's fleet.
 * @param {string}   props.editHref     Console deep-link opening this topology
 *                                      for editing.
 * @return {import('react').ReactElement} The control cluster.
 */
export default function TopologyControls( {
	name,
	active,
	onActivate,
	onDeactivate,
	onRestart,
	editHref,
} ) {
	// Every handler takes the topology name and nothing else; bind it once.
	const fire = ( fn ) => () => fn( name );

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

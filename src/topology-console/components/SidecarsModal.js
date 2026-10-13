/**
 * SidecarsModal — the grid a node's "…" opens: each sidecar, the owned node
 * the canvas never draws, as the card the canvas would draw for it, live off
 * the sidecar poller's rows and its own rate map. Picking a card shows
 * that sidecar's Inspector. The first card takes focus as the grid opens, so
 * a keyboard user chooses with no extra Tab.
 */

import { useEffect, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { ModalShell } from './Modal';
import {
	NODE_SHADOW,
	NODE_W,
	NodeCardDefs,
	bloomVars,
	useCardSurface,
} from './NodeCard';
import SidecarCard from './SidecarCard';

/** @typedef {import('../../runtime/metadata-node').MetadataGraphNode} MetadataGraphNode */
/** @typedef {import('../hooks/useGraphRates').RateEntry} RateEntry */

/**
 * @param {Object}                               props
 * @param {string}                               props.owner     The node that owns them.
 * @param {Array<{name: string, class: string}>} props.sidecars  Its sidecars, in the row's order.
 * @param {MetadataGraphNode[]}                  props.rows      The sidecar poller's rows; one not yet polled draws no count.
 * @param {Map<string, RateEntry>}               props.rates     The sidecar poller's rate map, keyed by node name.
 * @param {(name: string) => void}               props.onPick    Shows the chosen sidecar.
 * @param {() => void}                           props.onDismiss Closes the grid.
 * @return {import('react').ReactElement} The modal.
 */
export default function SidecarsModal( {
	owner,
	sidecars,
	rows,
	rates,
	onPick,
	onDismiss,
} ) {
	const firstRef = useRef( null );
	const surface = useCardSurface();
	const rowByName = new Map( rows.map( ( row ) => [ row.id, row ] ) );
	useEffect( () => {
		firstRef.current?.focus();
	}, [] );
	return (
		<ModalShell
			title={ sprintf(
				// translators: %s: the node that owns the listed nodes.
				__( 'Owned by %s', 'newspack-nodes' ),
				owner
			) }
			onDismiss={ onDismiss }
			className="topology-sidecars"
		>
			<div
				className="topology-modal__body topology-sidecars__grid"
				style={
					/** @type {import('react').CSSProperties} */ ( {
						'--topology-sidecars': sidecars.length,
						'--topology-sidecar-w': `${ NODE_W + NODE_SHADOW }px`,
						...bloomVars( surface ),
					} )
				}
			>
				<svg className="topology-sidecars__defs" aria-hidden="true">
					<defs>
						<NodeCardDefs surface={ surface } />
					</defs>
				</svg>
				{ sidecars.map( ( sidecar, i ) => (
					<SidecarCard
						key={ sidecar.name }
						surface={ surface }
						sidecar={ sidecar }
						row={ rowByName.get( sidecar.name ) }
						rate={ rates.get( sidecar.name ) }
						focusRef={ 0 === i ? firstRef : undefined }
						onPick={ onPick }
					/>
				) ) }
			</div>
		</ModalShell>
	);
}

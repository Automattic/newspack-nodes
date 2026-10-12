/**
 * SidecarsModal — the list a node's "…" opens: one card per sidecar, the
 * owned node the canvas never draws, naming its class. The first card takes
 * focus as the list opens, so a keyboard user chooses with no extra Tab.
 */

import { useEffect, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { ModalShell } from './Modal';

/**
 * @param {Object}                               props
 * @param {string}                               props.owner     The node that owns them.
 * @param {Array<{name: string, class: string}>} props.sidecars  Its sidecars, in the row's order.
 * @param {(name: string) => void}               props.onPick    Shows the chosen sidecar.
 * @param {() => void}                           props.onDismiss Closes the list.
 * @return {import('react').ReactElement} The modal.
 */
export default function SidecarsModal( {
	owner,
	sidecars,
	onPick,
	onDismiss,
} ) {
	const firstRef = useRef( null );
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
		>
			<div className="topology-modal__body">
				<ul className="topology-open-list">
					{ sidecars.map( ( sidecar, i ) => (
						<li key={ sidecar.name }>
							<button
								ref={ 0 === i ? firstRef : undefined }
								type="button"
								className="button topology-open-item"
								onClick={ () => onPick( sidecar.name ) }
							>
								<span className="topology-open-item__name">
									{ sidecar.name }
								</span>
								<span className="newspack-nodes-badge topology-open-item__badge">
									{ sidecar.class }
								</span>
							</button>
						</li>
					) ) }
				</ul>
			</div>
		</ModalShell>
	);
}

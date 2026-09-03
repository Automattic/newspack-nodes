/**
 * OpenTopologyModal — pick a saved topology to load into the edit-mode draft.
 * Entries group by source in a fixed order — user, both, stock — with an
 * `active` badge. Picking reports the name and nothing else: the console owns
 * the switch to edit mode and the confirm a dirty draft needs.
 */

import { useEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { ModalShell } from './Modal';

/**
 * Saved-topology picker.
 *
 * Cancel takes focus on mount, so Enter dismisses instead of loading whichever
 * topology happens to sort first.
 *
 * @param {Object}                 props
 * @param {Array<Object>}          props.topologies Catalog entries; each carries
 *                                                  `name`, `source` (`user`, `both`,
 *                                                  or `stock` — anything else groups
 *                                                  under stock), and `active`.
 * @param {boolean}                props.loading    The catalog fetch has not settled.
 * @param {string|null}            props.error      Failure from the catalog poll. Only
 *                                                  its presence is read: the banner
 *                                                  carries a fixed message, and it sits
 *                                                  above whatever the last good tick
 *                                                  listed rather than replacing it.
 * @param {(name: string) => void} props.onPick     Receives the chosen topology name,
 *                                                  on the item's mousedown rather than
 *                                                  its click.
 * @param {() => void}             props.onCancel   Dismiss without choosing.
 * @return {import('react').ReactElement} The modal.
 */
export default function OpenTopologyModal( {
	topologies,
	loading,
	error,
	onPick,
	onCancel,
} ) {
	const cancelRef = useRef( null );
	useEffect( () => {
		cancelRef.current?.focus();
	}, [] );

	const grouped = { user: [], both: [], stock: [] };
	for ( const t of topologies ) {
		( grouped[ t.source ] || grouped.stock ).push( t );
	}

	return (
		<ModalShell
			title={ __( 'Open topology', 'newspack-nodes' ) }
			onDismiss={ onCancel }
			className="topology-modal--wide"
		>
			<div className="topology-modal__body">
				{ loading && (
					<div className="newspack-nodes-performance-loading topology-edit-empty">
						{ __( 'Loading…', 'newspack-nodes' ) }
					</div>
				) }
				{ error && (
					<div className="newspack-nodes-error-banner topology-edit-empty topology-edit-empty--error">
						{ __( 'Failed to load list.', 'newspack-nodes' ) }
					</div>
				) }
				{ ! loading && ! error && ! topologies.length && (
					<div className="newspack-nodes-empty-state topology-edit-empty">
						{ __( 'No topologies registered.', 'newspack-nodes' ) }
					</div>
				) }

				{ [ 'user', 'both', 'stock' ].map( ( src ) => {
					const items = grouped[ src ];
					if ( ! items.length ) {
						return null;
					}
					return (
						<div key={ src } className="topology-open-group">
							<h4 className="topology-open-group__title">
								{ src }
							</h4>
							<ul className="topology-open-list">
								{ items.map( ( t ) => (
									<li key={ t.name }>
										<button
											type="button"
											className="button topology-open-item"
											onMouseDown={ () =>
												onPick( t.name )
											}
										>
											<span className="topology-open-item__name">
												{ t.name }
											</span>
											{ t.active && (
												<span className="newspack-nodes-badge topology-open-item__badge">
													{ __(
														'active',
														'newspack-nodes'
													) }
												</span>
											) }
										</button>
									</li>
								) ) }
							</ul>
						</div>
					);
				} ) }
			</div>
			<div className="topology-modal__actions">
				<button
					ref={ cancelRef }
					type="button"
					className="button"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

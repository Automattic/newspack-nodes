/**
 * OpenTopologyModal — pick a saved topology to load into the edit-mode draft.
 * Entries are grouped by source (user first) with an `active` badge.
 */

import { useEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';

function ModalShell( { title, onDismiss, children } ) {
	useEffect( () => {
		const onKey = ( e ) => {
			if ( 'Escape' === e.key ) {
				e.preventDefault();
				onDismiss();
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ onDismiss ] );

	return (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop click-to-dismiss; ESC handler attached above.
		<div
			className="topology-modal-backdrop"
			onMouseDown={ ( e ) => {
				if ( e.target === e.currentTarget ) {
					onDismiss();
				}
			} }
		>
			<div
				className="topology-modal topology-modal--wide"
				role="dialog"
				aria-modal="true"
				aria-label={ title }
			>
				<header className="topology-modal__header">{ title }</header>
				{ children }
			</div>
		</div>
	);
}

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
		>
			<div className="topology-modal__body">
				{ loading && (
					<div className="topology-edit-empty">
						{ __( 'Loading…', 'newspack-nodes' ) }
					</div>
				) }
				{ error && (
					<div className="topology-edit-empty topology-edit-empty--error">
						{ __( 'Failed to load list.', 'newspack-nodes' ) }
					</div>
				) }
				{ ! loading && ! error && ! topologies.length && (
					<div className="topology-edit-empty">
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
											className="topology-open-item"
											onMouseDown={ () =>
												onPick( t.name )
											}
										>
											<span className="topology-open-item__name">
												{ t.name }
											</span>
											{ t.active && (
												<span className="topology-open-item__badge">
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
					className="topology-modal__btn"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
			</div>
		</ModalShell>
	);
}

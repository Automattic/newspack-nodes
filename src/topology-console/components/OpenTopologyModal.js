/**
 * OpenTopologyModal — list every saved topology and let the operator
 * pick one to load into the edit-mode draft.
 *
 * One-shot affordance: the editor's draft is replaced wholesale by
 * the loaded TSL. If the operator had unsaved work, they should have
 * cancelled out (the discard-confirm modal) before opening this.
 *
 * Listed entries are grouped by source (user dirs first — the user's
 * own topologies are usually what they want to edit) and show the
 * `active` flag as a small badge so they can see at a glance which
 * topology is currently spawning workers.
 */

import { useEffect, useRef } from '@wordpress/element';

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
		<ModalShell title="Open topology" onDismiss={ onCancel }>
			<div className="topology-modal__body">
				{ loading && (
					<div className="topology-edit-empty">Loading…</div>
				) }
				{ error && (
					<div className="topology-edit-empty topology-edit-empty--error">
						Failed to load list.
					</div>
				) }
				{ ! loading && ! error && ! topologies.length && (
					<div className="topology-edit-empty">
						No topologies registered.
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
													active
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
					Cancel
				</button>
			</div>
		</ModalShell>
	);
}

/**
 * <VaultAdmin> — the thin React view over the Vault server-credential node graph.
 *
 * The graph (useVaultGraph) owns all data + the CRUD transport; this component
 * reads the published view model via `useNodeState('vault:view','view')` and
 * renders a server-credential table + add form. The markup reuses WordPress's
 * core admin class names (`wp-list-table`, `form-table`, …) so it inherits the
 * admin styling unchanged.
 *
 * A successful add / remove re-`list()`s and the table re-renders from the
 * fresh model (no page reload). Test status + the add-form validation messages
 * are local component state.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useNodeState } from '../runtime/react';
import { useVaultGraph } from './hooks/useVaultGraph';
import './VaultAdmin.scss';

// The view model before the first list publishes one — drives the loading gate.
const EMPTY_MODEL = {
	servers: null,
	loading: true,
	error: null,
};

/**
 * Pull a human-readable message off a thrown CommandClient error.
 *
 * @param {Error} err Thrown error from a CRUD callback.
 * @return {string} Display message.
 */
function errorMessage( err ) {
	return ( err && err.message ) || __( 'Error', 'newspack-nodes' );
}

/**
 * Substrate plain-DOM modal shell (no @wordpress/components): a backdrop + a
 * role="dialog" box. ESC and backdrop-click invoke `onClose`. Callers own their
 * own initial focus (so each modal focuses the element that fits it).
 *
 * @param {Object}                    props
 * @param {string}                    props.ariaLabel Accessible dialog label.
 * @param {Function}                  props.onClose   Dismiss handler (ESC / backdrop).
 * @param {import('react').ReactNode} props.children  Dialog body.
 * @return {import('react').ReactElement} The modal.
 */
function Modal( { ariaLabel, onClose, children } ) {
	useEffect( () => {
		const onKey = ( e ) => {
			if ( 'Escape' === e.key ) {
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener( 'keydown', onKey );
		return () => document.removeEventListener( 'keydown', onKey );
	}, [ onClose ] );

	return (
		<div
			className="nodes-vault__modal-backdrop"
			role="presentation"
			onMouseDown={ ( e ) => {
				if ( e.target === e.currentTarget ) {
					onClose();
				}
			} }
		>
			<div
				className="nodes-vault__modal"
				role="dialog"
				aria-modal="true"
				aria-label={ ariaLabel }
			>
				{ children }
			</div>
		</div>
	);
}

/**
 * Minimal confirm dialog. The confirm button focuses on mount.
 *
 * @param {Object}   props
 * @param {Function} props.onCancel  Dismiss handler.
 * @param {Function} props.onConfirm Confirm handler.
 * @return {import('react').ReactElement} The modal.
 */
function ConfirmRemoveModal( { onCancel, onConfirm } ) {
	const confirmRef = useRef( null );

	useEffect( () => {
		confirmRef.current?.focus();
	}, [] );

	return (
		<Modal
			ariaLabel={ __( 'Remove server', 'newspack-nodes' ) }
			onClose={ onCancel }
		>
			<p>
				{ __(
					'Are you sure you want to remove this server?',
					'newspack-nodes'
				) }
			</p>
			<div className="nodes-vault__modal-actions">
				<button
					type="button"
					className="button button-tertiary"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>{ ' ' }
				<button
					type="button"
					ref={ confirmRef }
					className="button button-primary button-link-delete"
					onClick={ onConfirm }
				>
					{ __( 'Remove', 'newspack-nodes' ) }
				</button>
			</div>
		</Modal>
	);
}

/**
 * A single server row — id / url / status + Test / Remove actions. Owns its own
 * per-row test-status string (set on Test).
 *
 * @param {Object}   props          Component props.
 * @param {Object}   props.server   Public server shape from the view model.
 * @param {Function} props.onRemove Remove callback (id).
 * @param {Function} props.onTest   Test callback (id) → probe promise.
 * @return {import('react').ReactElement} The rendered row.
 */
function ServerRow( { server, onRemove, onTest } ) {
	const { id, url } = server;
	const [ testStatus, setTestStatus ] = useState( { text: '', color: '' } );
	const [ busy, setBusy ] = useState( false );
	const [ isConfirmOpen, setIsConfirmOpen ] = useState( false );

	const handleTest = async () => {
		setBusy( true );
		setTestStatus( {
			text: __( 'Testing…', 'newspack-nodes' ),
			color: '',
		} );
		try {
			await onTest( id );
			setTestStatus( {
				text: __( 'Connected!', 'newspack-nodes' ),
				color: 'green',
			} );
		} catch ( err ) {
			setTestStatus( {
				text: sprintf(
					// translators: %s: connection error message.
					__( 'Failed: %s', 'newspack-nodes' ),
					errorMessage( err )
				),
				color: 'red',
			} );
		} finally {
			setBusy( false );
		}
	};

	// Remove opens a confirm dialog; onConfirm runs the removal.
	const handleRemove = () => setIsConfirmOpen( true );

	const confirmRemove = async () => {
		setIsConfirmOpen( false );
		setBusy( true );
		try {
			await onRemove( id );
		} finally {
			setBusy( false );
		}
	};

	const cancelRemove = () => setIsConfirmOpen( false );

	return (
		<tr data-server-id={ id }>
			<td>
				<code>{ id }</code>
			</td>
			<td>{ url }</td>
			<td>
				<span
					className="test-status"
					style={ { color: testStatus.color } }
				>
					{ testStatus.text }
				</span>
			</td>
			<td>
				<button
					type="button"
					className="button button-small event-aggregator-test"
					data-server-id={ id }
					disabled={ busy }
					onClick={ handleTest }
				>
					{ __( 'Test', 'newspack-nodes' ) }
				</button>{ ' ' }
				<button
					type="button"
					className="button button-small button-link-delete event-aggregator-remove"
					data-server-id={ id }
					disabled={ busy }
					onClick={ handleRemove }
				>
					{ __( 'Remove', 'newspack-nodes' ) }
				</button>
				{ isConfirmOpen && (
					<ConfirmRemoveModal
						onCancel={ cancelRemove }
						onConfirm={ confirmRemove }
					/>
				) }
			</td>
		</tr>
	);
}

/**
 * The "Add New Server" form — id / url / username / password + submit. Owns the
 * field state + the validation/status line. Rendered inside the add-server modal.
 *
 * @param {Object}   props           Component props.
 * @param {Function} props.onAdd     Add callback (fields) → add promise.
 * @param {Function} props.onSuccess Called after a successful add (closes the modal).
 * @param {Function} props.onCancel  Dismiss handler for the footer Cancel button.
 * @return {import('react').ReactElement} The rendered form.
 */
function AddServerForm( { onAdd, onSuccess, onCancel } ) {
	const [ id, setId ] = useState( '' );
	const [ url, setUrl ] = useState( '' );
	const [ username, setUsername ] = useState( '' );
	const [ password, setPassword ] = useState( '' );
	const [ status, setStatus ] = useState( { text: '', color: '' } );
	const [ busy, setBusy ] = useState( false );
	const idRef = useRef( null );

	// Focus the first field when the modal opens.
	useEffect( () => {
		idRef.current?.focus();
	}, [] );

	const handleAdd = async () => {
		const trimmedId = id.trim();
		if ( ! trimmedId ) {
			setStatus( {
				text: __( 'ID is required', 'newspack-nodes' ),
				color: 'red',
			} );
			return;
		}
		const trimmedUrl = url.trim();
		if ( ! trimmedUrl ) {
			setStatus( {
				text: __( 'Server URL is required', 'newspack-nodes' ),
				color: 'red',
			} );
			return;
		}
		if ( ! trimmedUrl.startsWith( 'https://' ) ) {
			setStatus( {
				text: __( 'URL must start with https://', 'newspack-nodes' ),
				color: 'red',
			} );
			return;
		}

		setBusy( true );
		setStatus( {
			text: __( 'Adding…', 'newspack-nodes' ),
			color: '',
		} );
		try {
			await onAdd( {
				id: trimmedId,
				url: trimmedUrl,
				auth_username: username.trim(),
				auth_password: password,
			} );
			// Success: the hook re-lists and the table re-renders (no reload);
			// onSuccess closes the modal, so the fresh row is the confirmation.
			setId( '' );
			setUrl( '' );
			setUsername( '' );
			setPassword( '' );
			onSuccess?.();
		} catch ( err ) {
			setStatus( {
				text: sprintf(
					// translators: %s: error message.
					__( 'Error: %s', 'newspack-nodes' ),
					errorMessage( err )
				),
				color: 'red',
			} );
		} finally {
			setBusy( false );
		}
	};

	return (
		<>
			<table className="form-table" style={ { maxWidth: '600px' } }>
				<tbody>
					<tr>
						<th>
							<label htmlFor="new-server-id">
								{ __( 'ID', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								ref={ idRef }
								type="text"
								id="new-server-id"
								className="regular-text"
								placeholder="prod-web-01"
								pattern="[a-zA-Z0-9_-]+"
								value={ id }
								onChange={ ( e ) => setId( e.target.value ) }
							/>
							<p className="description">
								{ __(
									'Unique identifier (alphanumeric, hyphen, underscore).',
									'newspack-nodes'
								) }
							</p>
						</td>
					</tr>
					<tr>
						<th>
							<label htmlFor="new-server-url">
								{ __( 'Server URL', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								type="url"
								id="new-server-url"
								className="regular-text"
								placeholder="https://example.com"
								value={ url }
								onChange={ ( e ) => setUrl( e.target.value ) }
							/>
							<p className="description">
								{ __(
									'HTTPS URL of the WordPress site.',
									'newspack-nodes'
								) }
							</p>
						</td>
					</tr>
					<tr>
						<th>
							<label htmlFor="new-server-username">
								{ __( 'Username', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								type="text"
								id="new-server-username"
								className="regular-text"
								value={ username }
								onChange={ ( e ) =>
									setUsername( e.target.value )
								}
							/>
							<p className="description">
								{ __(
									'WordPress username on the remote site.',
									'newspack-nodes'
								) }
							</p>
						</td>
					</tr>
					<tr>
						<th>
							<label htmlFor="new-server-password">
								{ __(
									'Application Password',
									'newspack-nodes'
								) }
							</label>
						</th>
						<td>
							<input
								type="password"
								id="new-server-password"
								className="regular-text"
								value={ password }
								onChange={ ( e ) =>
									setPassword( e.target.value )
								}
							/>
							<p className="description">
								{ __(
									'WordPress Application Password (Users → Profile → Application Passwords).',
									'newspack-nodes'
								) }
							</p>
						</td>
					</tr>
				</tbody>
			</table>
			<div className="nodes-vault__modal-actions">
				<span
					id="add-server-status"
					className="nodes-vault__add-status"
					style={ { color: status.color } }
				>
					{ status.text }
				</span>
				<button
					type="button"
					className="button button-tertiary"
					onClick={ onCancel }
				>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className="button button-primary"
					id="event-aggregator-add-server"
					disabled={ busy }
					onClick={ handleAdd }
				>
					{ __( 'Add Server', 'newspack-nodes' ) }
				</button>
			</div>
		</>
	);
}

/**
 * The add-server modal: the heading + the AddServerForm. Closes on a successful
 * add (onSuccess → onClose) or on ESC / backdrop / Cancel.
 *
 * @param {Object}   props         Component props.
 * @param {Function} props.onAdd   Add callback (fields) → add promise.
 * @param {Function} props.onClose Dismiss handler.
 * @return {import('react').ReactElement} The modal.
 */
function AddServerModal( { onAdd, onClose } ) {
	return (
		<Modal
			ariaLabel={ __( 'Add new server', 'newspack-nodes' ) }
			onClose={ onClose }
		>
			<h4>{ __( 'Add New Server', 'newspack-nodes' ) }</h4>
			<AddServerForm
				onAdd={ onAdd }
				onSuccess={ onClose }
				onCancel={ onClose }
			/>
		</Modal>
	);
}

/**
 * Vault server-credential admin app. Reads the view model the graph publishes
 * and renders the server table + add form.
 *
 * @return {import('react').ReactElement} The rendered admin app.
 */
export default function VaultAdmin() {
	// Mount the node graph; it owns the list-on-mount, the CRUD transport, and the
	// re-list-after-mutation.
	const { addServer, removeServer, testServer } = useVaultGraph();

	// The single read surface: the render model the graph publishes.
	const model = useNodeState( 'vault:view', 'view' ) ?? EMPTY_MODEL;
	const { servers, error } = model;

	const [ isAddOpen, setIsAddOpen ] = useState( false );

	return (
		<div className="event-aggregator-servers-admin">
			{ error && (
				<div className="notice notice-error">
					<p>{ error }</p>
				</div>
			) }
			<div className="nodes-vault__header">
				<h1 className="newspack-dashboard-title">
					{ __( 'Vault', 'newspack-nodes' ) }
				</h1>
				<button
					type="button"
					className="page-title-action"
					onClick={ () => setIsAddOpen( true ) }
				>
					{ __( 'Add Server', 'newspack-nodes' ) }
				</button>
			</div>
			<table
				className="wp-list-table widefat fixed striped"
				style={ { maxWidth: '800px' } }
			>
				<thead>
					<tr>
						<th style={ { width: '12%' } }>
							{ __( 'ID', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '53%' } }>
							{ __( 'URL', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '15%' } }>
							{ __( 'Status', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '20%' } }>
							{ __( 'Actions', 'newspack-nodes' ) }
						</th>
					</tr>
				</thead>
				<tbody>
					{ servers && servers.length > 0 ? (
						servers.map( ( server ) => (
							<ServerRow
								key={ server.id }
								server={ server }
								onRemove={ removeServer }
								onTest={ testServer }
							/>
						) )
					) : (
						<tr>
							<td colSpan="4">
								{ __(
									'No servers configured.',
									'newspack-nodes'
								) }
							</td>
						</tr>
					) }
				</tbody>
			</table>

			{ isAddOpen && (
				<AddServerModal
					onAdd={ addServer }
					onClose={ () => setIsAddOpen( false ) }
				/>
			) }
		</div>
	);
}

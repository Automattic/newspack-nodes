/**
 * <VaultAdmin> — the thin React view over the Vault server-credential node graph.
 *
 * The graph (useVaultGraph) owns all data + the CRUD transport across two
 * per-concern views; this component reads the credential-LIST view model via
 * `useNodeState('vault:list','view')` and renders a server-credential table +
 * add form. (The TEST-result concern publishes into the sibling `vault:test`
 * view; each row's Test status is surfaced locally from the test() callback.)
 * The credential list uses the substrate's canonical themed table. The add
 * form keeps WordPress's structural `form-table` layout.
 *
 * A successful add / remove re-`list()`s and the table re-renders from the
 * fresh model (no page reload). Test status + the add-form validation messages
 * are local component state.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useVaultGraph, VAULT_CI } from './hooks/useVaultGraph';
import { useCommandOnce } from '@newspack-nodes/shared/hooks/useCommandOnce';
import { formatCommandArgs } from '../runtime/command-args';
import './vault-admin.scss';
import { primaryButtonClass } from '@newspack-nodes/shared/utils/buttonClass';
import { answerStatus } from '@newspack-nodes/shared/utils/answerStatus';
import Modal from '@newspack-nodes/shared/components/Modal';
import { HeaderSlot } from '@newspack-nodes/shared/components/HeaderSlot';

/**
 * Minimal confirm dialog. The confirm button focuses on mount.
 *
 * @param {Object}     props
 * @param {() => void} props.onCancel  Dismisses without removing.
 * @param {() => void} props.onConfirm Runs the removal.
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
			<div className="newspack-nodes-modal__actions">
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>{ ' ' }
				<button
					type="button"
					ref={ confirmRef }
					className="button button-link-delete"
					onClick={ onConfirm }
				>
					{ __( 'Remove', 'newspack-nodes' ) }
				</button>
			</div>
		</Modal>
	);
}

// What each verb says on a row, in that verb's own words.
const ROW_TEXTS = {
	test: {
		busy: __( 'Testing…', 'newspack-nodes' ),
		failed: ( e ) =>
			// translators: %s: connection error message.
			sprintf( __( 'Failed: %s', 'newspack-nodes' ), e ),
		ok: __( 'Connected!', 'newspack-nodes' ),
	},
	delete: {
		busy: __( 'Working…', 'newspack-nodes' ),
		failed: ( e ) =>
			// translators: %s: removal error message.
			sprintf( __( 'Remove failed: %s', 'newspack-nodes' ), e ),
	},
};

/**
 * A single server row — id / url / status + Test / Remove actions.
 *
 * The row OWNS its two verbs, each scoped to this server, so their replies land
 * on nodes that serve this row and no other. One node per verb across every row
 * would be one node doing N jobs: the second row's reply lands where the
 * first's did and blanks the first row's status line.
 *
 * @param {Object}   props           Component props.
 * @param {Object}   props.server    Public server shape from the view model.
 * @param {Function} props.onChanged Called when this row changed the list.
 * @return {import('react').ReactElement} The rendered row.
 */
function ServerRow( { server, onChanged } ) {
	const { id, url } = server;
	const [ isConfirmOpen, setIsConfirmOpen ] = useState( false );

	const test = useCommandOnce( {
		ci: VAULT_CI,
		command: 'test',
		scope: `${ VAULT_CI }:test:${ id }`,
	} );
	const remove = useCommandOnce( {
		ci: VAULT_CI,
		command: 'delete',
		scope: `${ VAULT_CI }:delete:${ id }`,
		onDone: onChanged,
	} );

	// Its own two verbs, and one status line: a removal outranks a probe.
	const verb = remove.pending || remove.answeredArgs ? 'delete' : 'test';
	const active = 'delete' === verb ? remove : test;
	const busy = active.pending;
	const status = answerStatus(
		busy || active.answeredArgs ? { busy, error: active.error } : null,
		ROW_TEXTS[ verb ]
	);

	const confirmRemove = () => {
		setIsConfirmOpen( false );
		remove.run( formatCommandArgs( [ id ] ) );
	};

	return (
		<tr data-server-id={ id }>
			<td>
				<code>{ id }</code>
			</td>
			<td>{ url }</td>
			<td>
				<span
					className={ `newspack-nodes-status test-status ${ status.tone }` }
				>
					{ status.text }
				</span>
			</td>
			<td>
				<button
					type="button"
					className="button button-small event-aggregator-test"
					data-server-id={ id }
					disabled={ busy }
					onClick={ () => test.run( formatCommandArgs( [ id ] ) ) }
				>
					{ __( 'Test', 'newspack-nodes' ) }
				</button>{ ' ' }
				<button
					type="button"
					className="button button-small button-link-delete event-aggregator-remove"
					data-server-id={ id }
					disabled={ busy }
					onClick={ () => setIsConfirmOpen( true ) }
				>
					{ __( 'Remove', 'newspack-nodes' ) }
				</button>
				{ isConfirmOpen && (
					<ConfirmRemoveModal
						onCancel={ () => setIsConfirmOpen( false ) }
						onConfirm={ confirmRemove }
					/>
				) }
			</td>
		</tr>
	);
}

const ADD_TEXTS = {
	busy: __( 'Adding…', 'newspack-nodes' ),
	failed: ( e ) =>
		// translators: %s: error message.
		sprintf( __( 'Error: %s', 'newspack-nodes' ), e ),
};

/**
 * The form's own refusal, before anything is sent.
 *
 * @param {string} id  Trimmed server id.
 * @param {string} url Trimmed server URL.
 * @return {string} The refusal text, or '' when the fields are usable.
 */
function validate( id, url ) {
	if ( ! id ) {
		return __( 'ID is required', 'newspack-nodes' );
	}
	if ( ! url ) {
		return __( 'Server URL is required', 'newspack-nodes' );
	}
	if ( ! url.startsWith( 'https://' ) ) {
		return __( 'URL must start with https://', 'newspack-nodes' );
	}
	return '';
}

/**
 * The "Add New Server" form — id / url / username / password + submit. Owns the
 * field state + the validation/status line. Rendered inside the add-server modal.
 *
 * The add is this form's OWN verb, so its reply lands here: a success closes
 * the modal, a refusal fills the status line and leaves the fields alone.
 *
 * @param {Object}     props           Component props.
 * @param {Function}   props.onAdded   Called when the add succeeded.
 * @param {Function}   props.onChanged Called on any reply, to refresh the list.
 * @param {() => void} props.onCancel  Dismisses the modal from the footer Cancel button.
 * @return {import('react').ReactElement} The rendered form.
 */
function AddServerForm( { onAdded, onChanged, onCancel } ) {
	const [ id, setId ] = useState( '' );
	const [ url, setUrl ] = useState( '' );
	const [ username, setUsername ] = useState( '' );
	const [ password, setPassword ] = useState( '' );
	// Local validation only; the reply below supplies everything else.
	const [ invalid, setInvalid ] = useState( '' );
	const idRef = useRef( null );

	const add = useCommandOnce( {
		ci: VAULT_CI,
		command: 'add',
		onDone: ( { error } ) => {
			onChanged();
			if ( ! error ) {
				onAdded();
			}
		},
	} );

	const busy = add.pending;
	const status = invalid
		? { text: invalid, tone: 'is-error' }
		: answerStatus(
				busy || add.answeredArgs ? { busy, error: add.error } : null,
				ADD_TEXTS
		  );

	// Focus the first field when the modal opens.
	useEffect( () => {
		idRef.current?.focus();
	}, [] );

	const handleAdd = () => {
		const trimmedId = id.trim();
		const trimmedUrl = url.trim();
		const refusal = validate( trimmedId, trimmedUrl );
		setInvalid( refusal );
		if ( refusal ) {
			return;
		}
		// id is positional; credentials are named args.
		add.run(
			formatCommandArgs( [ trimmedId ], {
				url: trimmedUrl,
				auth_username: username.trim(),
				auth_password: password,
			} )
		);
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
			<div className="newspack-nodes-modal__actions">
				<span
					id="add-server-status"
					className={ `newspack-nodes-status nodes-vault__add-status ${ status.tone }` }
				>
					{ status.text }
				</span>
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( busy ) }
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
 * @param {Object}     props           Component props.
 * @param {Function}   props.onChanged Called on any reply, to refresh the list.
 * @param {() => void} props.onClose   Dismisses the modal.
 * @return {import('react').ReactElement} The modal.
 */
function AddServerModal( { onChanged, onClose } ) {
	return (
		<Modal
			ariaLabel={ __( 'Add new server', 'newspack-nodes' ) }
			onClose={ onClose }
		>
			<h4 className="newspack-nodes-modal__title">
				{ __( 'Add New Server', 'newspack-nodes' ) }
			</h4>
			<AddServerForm
				onAdded={ onClose }
				onChanged={ onChanged }
				onCancel={ onClose }
			/>
		</Modal>
	);
}

/**
 * Vault server-credential admin app. Reads the view model the graph publishes
 * and renders the server table + add form.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} The rendered admin app.
 */
export default function VaultAdmin( { headerControlsSlot } ) {
	const [ isAddOpen, setIsAddOpen ] = useState( false );
	// The list; every verb belongs to the row or the form that sends it.
	const { servers, error, refresh } = useVaultGraph();

	// Portal the +Add trigger into the hub header slot (undefined=inline).
	const controls = (
		<button
			type="button"
			className="nodes-cards__new nodes-vault__add-trigger button"
			onClick={ () => setIsAddOpen( true ) }
		>
			{ __( '+ Add Server', 'newspack-nodes' ) }
		</button>
	);

	return (
		<div className="event-aggregator-servers-admin">
			{ error && (
				<div className="newspack-nodes-error-banner">
					<p>{ error }</p>
				</div>
			) }
			<HeaderSlot slot={ headerControlsSlot }>{ controls }</HeaderSlot>
			<table className="newspack-nodes-table">
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
								onChanged={ refresh }
							/>
						) )
					) : (
						<tr>
							<td colSpan={ 4 }>
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
					onChanged={ refresh }
					onClose={ () => setIsAddOpen( false ) }
				/>
			) }
		</div>
	);
}

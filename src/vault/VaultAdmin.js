/**
 * <VaultAdmin> — the thin React view over the Vault server-credential node graph.
 *
 * The graph (useVaultGraph) owns all data + the CRUD transport across two
 * per-concern views; this component reads the credential-LIST view model via
 * `useNodeState('vault:list','view')` and renders a server-credential table +
 * the add/edit form. (The TEST-result concern publishes into the sibling
 * `vault:test` view; each row's Test status is surfaced locally from the test()
 * callback.) The credential list uses the substrate's canonical themed table.
 * The form keeps WordPress's structural `form-table` layout.
 *
 * ONE form serves add and edit, seeded blank or from the row: the two collect
 * the same four fields, and the verb is the only difference — so it is the only
 * thing that varies, right down to the words the status line uses.
 *
 * A successful add / edit / remove re-`list()`s and the table re-renders from
 * the fresh model (no page reload). Test status + the form's validation
 * messages are local component state.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useVaultGraph } from './hooks/useVaultGraph';
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

const errorText = ( e ) =>
	// translators: %s: error message.
	sprintf( __( 'Error: %s', 'newspack-nodes' ), e );

// What each verb says about its own outcome, in that verb's own words.
const VERB_TEXTS = {
	add: { busy: __( 'Adding…', 'newspack-nodes' ), failed: errorText },
	update: { busy: __( 'Saving…', 'newspack-nodes' ), failed: errorText },
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

/** What the form starts from when it is adding rather than editing. */
const BLANK_SERVER = { id: '', url: '', auth_username: '' };

/**
 * A single server row — id / url / status + Test / Edit / Remove actions.
 *
 * The row renders the answer that NAMED it. Each reply arrives already
 * addressed to one server — the sender put it in the reply path — so the table
 * hands each row its own, and a sibling being tested cannot blank this line.
 *
 * @param {Object}   props          Component props.
 * @param {Object}   props.server   Public server shape from the view model.
 * @param {?Object}  props.answer   This row's last answer, or null.
 * @param {?string}  props.pending  The verb outstanding about this row, if any.
 * @param {Function} props.onEdit   Edit callback (server).
 * @param {Function} props.onRemove Remove callback (id).
 * @param {Function} props.onTest   Test callback (id).
 * @return {import('react').ReactElement} The rendered row.
 */
function ServerRow( { server, answer, pending, onEdit, onRemove, onTest } ) {
	const { id, url } = server;
	const [ isConfirmOpen, setIsConfirmOpen ] = useState( false );
	const busy = Boolean( pending );
	// Pinned by the config file, so the store refuses both verbs anyway.
	const pinned = Boolean( server.is_config );
	// The outstanding verb picks the words; the answered one after.
	const status = answerStatus(
		answer,
		VERB_TEXTS[ pending ?? answer?.verb ] ?? {},
		busy
	);

	const confirmRemove = () => {
		setIsConfirmOpen( false );
		onRemove( id );
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
					className="button button-small nodes-vault__test"
					data-server-id={ id }
					disabled={ busy }
					onClick={ () => onTest( id ) }
				>
					{ __( 'Test', 'newspack-nodes' ) }
				</button>{ ' ' }
				<button
					type="button"
					className="button button-small nodes-vault__edit"
					data-server-id={ id }
					disabled={ busy || pinned }
					onClick={ () => onEdit( server ) }
				>
					{ __( 'Edit', 'newspack-nodes' ) }
				</button>{ ' ' }
				<button
					type="button"
					className="button button-small button-link-delete nodes-vault__remove"
					data-server-id={ id }
					disabled={ busy || pinned }
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
 * The server form — id / url / username / password + submit. Owns the field
 * state + the validation/status line. Rendered inside the server modal.
 *
 * The seed says which act this is: a server with no id yet is one being added,
 * the same signal the rules editor takes from its own blank draft. The answer
 * arrives named after the id that was SENT — the row's existing one on an edit
 * — like every other verb here, so the form renders it the way a row does.
 *
 * @param {Object}     props          Component props.
 * @param {Object}     props.server   The row being edited, or BLANK_SERVER.
 * @param {Function}   props.onSave   Save callback (fields).
 * @param {?Object}    props.answer   The answer for the submitted id, if any.
 * @param {boolean}    props.busy     Whether the save is outstanding.
 * @param {() => void} props.onCancel Dismisses the modal from the footer Cancel button.
 * @return {import('react').ReactElement} The rendered form.
 */
function ServerForm( { server, onSave, answer, busy, onCancel } ) {
	const isNew = '' === server.id;
	const [ id, setId ] = useState( server.id );
	const [ url, setUrl ] = useState( server.url );
	const [ username, setUsername ] = useState( server.auth_username ?? '' );
	// Never seeded: the stored password does not reach the browser at all.
	const [ password, setPassword ] = useState( '' );
	// Local validation only; the answer supplies everything else.
	const [ invalid, setInvalid ] = useState( '' );
	const idRef = useRef( null );

	const status = invalid
		? { text: invalid, tone: 'is-error' }
		: answerStatus( answer, VERB_TEXTS[ isNew ? 'add' : 'update' ], busy );

	// Focus the first field when the modal opens.
	useEffect( () => {
		idRef.current?.focus();
	}, [] );

	const handleSave = () => {
		const trimmedId = id.trim();
		const trimmedUrl = url.trim();
		const refusal = validate( trimmedId, trimmedUrl );
		setInvalid( refusal );
		if ( refusal ) {
			return;
		}
		onSave( {
			id: trimmedId,
			url: trimmedUrl,
			auth_username: username.trim(),
			auth_password: password,
		} );
	};

	return (
		<>
			<table className="form-table" style={ { maxWidth: '600px' } }>
				<tbody>
					<tr>
						<th>
							<label htmlFor="vault-server-id">
								{ __( 'ID', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								ref={ idRef }
								type="text"
								id="vault-server-id"
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
								{ ! isNew &&
									` ${ __(
										'Renaming does not update topologies that name it — those spokes stay disconnected until you edit them.',
										'newspack-nodes'
									) }` }
							</p>
						</td>
					</tr>
					<tr>
						<th>
							<label htmlFor="vault-server-url">
								{ __( 'Server URL', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								type="url"
								id="vault-server-url"
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
							<label htmlFor="vault-server-username">
								{ __( 'Username', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								type="text"
								id="vault-server-username"
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
							<label htmlFor="vault-server-password">
								{ __(
									'Application Password',
									'newspack-nodes'
								) }
							</label>
						</th>
						<td>
							<input
								type="password"
								id="vault-server-password"
								className="regular-text"
								value={ password }
								onChange={ ( e ) =>
									setPassword( e.target.value )
								}
							/>
							<p className="description">
								{ isNew
									? __(
											'WordPress Application Password (Users → Profile → Application Passwords).',
											'newspack-nodes'
									  )
									: __(
											'Leave blank to keep the stored password.',
											'newspack-nodes'
									  ) }
							</p>
						</td>
					</tr>
				</tbody>
			</table>
			<div className="newspack-nodes-modal__actions">
				<span
					id="vault-server-status"
					className={ `newspack-nodes-status nodes-vault__save-status ${ status.tone }` }
				>
					{ status.text }
				</span>
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ primaryButtonClass( busy ) }
					id="vault-server-save"
					disabled={ busy }
					onClick={ handleSave }
				>
					{ isNew
						? __( 'Add Server', 'newspack-nodes' )
						: __( 'Save Changes', 'newspack-nodes' ) }
				</button>
			</div>
		</>
	);
}

/**
 * The server modal: the heading + the ServerForm. Closes on a successful save
 * (the answer clears `editing`) or on ESC / backdrop / Cancel.
 *
 * @param {Object}     props         Component props.
 * @param {Object}     props.server  The row being edited, or BLANK_SERVER.
 * @param {Function}   props.onSave  Save callback (fields).
 * @param {?Object}    props.answer  The answer for the submitted id, if any.
 * @param {boolean}    props.busy    Whether the save is outstanding.
 * @param {() => void} props.onClose Dismisses the modal.
 * @return {import('react').ReactElement} The modal.
 */
function ServerModal( { server, onSave, answer, busy, onClose } ) {
	const title =
		'' === server.id
			? __( 'Add New Server', 'newspack-nodes' )
			: __( 'Edit Server', 'newspack-nodes' );

	return (
		<Modal ariaLabel={ title } onClose={ onClose }>
			<h4 className="newspack-nodes-modal__title">{ title }</h4>
			<ServerForm
				server={ server }
				onSave={ onSave }
				answer={ answer }
				busy={ busy }
				onCancel={ onClose }
			/>
		</Modal>
	);
}

/**
 * Vault server-credential admin app. Reads the view model the graph publishes
 * and renders the server table + add/edit form.
 *
 * @param {Object}  props                      Props.
 * @param {Element} [props.headerControlsSlot] Hub shared-header slot to portal the controls into.
 * @return {import('react').ReactElement} The rendered admin app.
 */
export default function VaultAdmin( { headerControlsSlot } ) {
	// The row open in the form; BLANK_SERVER means adding, null means closed.
	const [ editing, setEditing ] = useState( null );
	const [ submitted, setSubmitted ] = useState( null );
	// @longform Each row's last answer, put there BY the reply that named it.
	// This is the screen laying out answers it was handed, not a correlation
	// table: the graph did the matching, in the address, before it got here —
	// which is why a row keeps its line when a sibling is tested.
	const [ answers, setAnswers ] = useState( {} );
	const {
		servers,
		error,
		addServer,
		updateServer,
		removeServer,
		testServer,
		pendingVerb,
	} = useVaultGraph( {
		onAnswer: ( { verb, subject, error: refusal } ) => {
			setAnswers( ( prior ) => ( {
				...prior,
				[ subject ]: { verb, error: refusal },
			} ) );
			// A successful save closes the modal, on its own answer.
			if ( ! refusal && ( 'add' === verb || 'update' === verb ) ) {
				setEditing( null );
				setSubmitted( null );
			}
		},
	} );

	// An entry with no id yet is one being added; everything else is an edit.
	const verb = editing && '' === editing.id ? 'add' : 'update';

	const saveServer = ( fields ) => {
		if ( 'add' === verb ) {
			setSubmitted( fields.id );
			addServer( fields );
			return;
		}
		// Addressed by the id the row HAS — the new one rides as a field.
		setSubmitted( editing.id );
		updateServer( editing.id, fields );
	};

	// Portal the +Add trigger into the hub header slot (undefined=inline).
	const controls = (
		<button
			type="button"
			className="nodes-cards__new nodes-vault__add-trigger button"
			onClick={ () => setEditing( BLANK_SERVER ) }
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
						<th style={ { width: '48%' } }>
							{ __( 'URL', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '15%' } }>
							{ __( 'Status', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '25%' } }>
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
								answer={ answers[ server.id ] ?? null }
								pending={ pendingVerb( server.id ) }
								onEdit={ setEditing }
								onRemove={ removeServer }
								onTest={ testServer }
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

			{ editing && (
				<ServerModal
					server={ editing }
					onSave={ saveServer }
					answer={ answers[ submitted ] ?? null }
					busy={ verb === pendingVerb( submitted ) }
					onClose={ () => {
						setEditing( null );
						setSubmitted( null );
					} }
				/>
			) }
		</div>
	);
}

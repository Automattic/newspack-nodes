/**
 * <SessionsAdmin> — the React view over the issued-session node graph.
 *
 * Vault's mirror: Vault lists the credentials this site sends OUT, this lists
 * the ones it hands to callers coming IN — an agent's MCP client, a script on
 * a laptop — and, below them, the OAuth connections people approved, each of
 * which mints its own sessions. `useSessionsGraph` owns the data and the
 * transport, so every component here is presentation over the model that hook
 * returns and over the two verbs it exposes.
 *
 * The key is disclosed exactly once, in the create answer. The verifier
 * recomputes an HMAC from it, so it is stored recoverable rather than hashed
 * and nothing gets it back out of the listing. A short lifetime is the
 * compensation, so the lifetime field carries the server's ceiling and the
 * reason for staying well under it.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useSessionsGraph } from './hooks/useSessionsGraph';
import Modal from '@newspack-nodes/shared/components/Modal';
import { primaryButtonClass } from '@newspack-nodes/shared/utils/buttonClass';
import { answerStatus } from '@newspack-nodes/shared/utils/answerStatus';
import './sessions-admin.scss';
import { HeaderSlot } from '@newspack-nodes/shared/components/HeaderSlot';

/** The scope the form preselects when the server lists it. */
const DEFAULT_SCOPE = 'tune';

/**
 * The lifetime the form prefills, in seconds — `Command_Auth::SESSION_TTL_S`.
 *
 * The `list` verb serves the ceiling (`ttl_max`) and not the default, so this
 * copy is free to drift. Drift costs a prefilled number and never a bad
 * session: `Command_Auth::bounded_ttl()` clamps whatever it is sent.
 */
const DEFAULT_TTL_S = 3600;

/**
 * The words a row shows for its revoke, as `answerStatus` reads them.
 *
 * No `ok` text: `Sessions::revoke()` drops the session's row, and the listing
 * lists only rows still standing, so a revoke that succeeds takes away the
 * line the confirmation would have been written on.
 */
const REVOKE_TEXTS = {
	failed: ( e ) =>
		// translators: %s: revocation error message.
		sprintf( __( 'Revoke failed: %s', 'newspack-nodes' ), e ),
};

/**
 * The words the create form shows for its own verb, as `answerStatus` reads
 * them.
 *
 * No `ok` text here either: success replaces the whole form with the key
 * panel, which says everything a confirmation line would.
 */
const CREATE_TEXTS = {
	busy: __( 'Issuing…', 'newspack-nodes' ),
	failed: ( e ) =>
		// translators: %s: error message.
		sprintf( __( 'Error: %s', 'newspack-nodes' ), e ),
};

/**
 * Absolute time, or an em dash when the stamp is missing.
 *
 * @param {number} seconds Unix timestamp in seconds.
 * @return {string} Localized time, or an em dash.
 */
function when( seconds ) {
	if ( ! seconds ) {
		return '—';
	}
	return new Date( seconds * 1000 ).toLocaleString();
}

/**
 * A scope as the tables show it, one badge class per scope.
 *
 * @param {Object} props
 * @param {string} props.scope The scope name.
 * @return {import('react').ReactElement} The badge.
 */
function ScopeBadge( { scope } ) {
	return (
		<span
			className={ `newspack-nodes-badge nodes-sessions__scope is-${ scope }` }
		>
			{ scope }
		</span>
	);
}

/**
 * A row's Revoke button, its last answer and the confirmation it asks first.
 *
 * The cell owns no answer state. A revoke answers once, naming the id it was
 * about, and the graph keeps that answer per id, so a row keeps its own line
 * while a sibling is revoked in the same second.
 *
 * @param {Object}   props
 * @param {string}   props.id       The session handle or grant id to revoke.
 * @param {?Object}  props.answer   This row's last answer, or null.
 * @param {boolean}  props.busy     Whether a revoke of this row is outstanding.
 * @param {Function} props.onRevoke Revoke callback, taking the id.
 * @param {string}   props.title    The confirmation dialog's accessible name.
 * @param {string}   props.warning  What revoking ends, as the dialog says it.
 * @return {import('react').ReactElement} The rendered cell.
 */
function RevokeCell( { id, answer, busy, onRevoke, title, warning } ) {
	const [ isConfirmOpen, setIsConfirmOpen ] = useState( false );
	const status = answerStatus( answer, REVOKE_TEXTS, busy ).text;

	const confirmRevoke = () => {
		setIsConfirmOpen( false );
		onRevoke( id );
	};

	return (
		<td>
			<button
				type="button"
				className="button button-small button-link-delete"
				disabled={ busy }
				onClick={ () => setIsConfirmOpen( true ) }
			>
				{ __( 'Revoke', 'newspack-nodes' ) }
			</button>
			{ status && (
				<div className="nodes-sessions__row-status">{ status }</div>
			) }
			{ isConfirmOpen && (
				<Modal
					ariaLabel={ title }
					onClose={ () => setIsConfirmOpen( false ) }
				>
					<p>{ warning }</p>
					<div className="newspack-nodes-modal__actions">
						<button
							type="button"
							className="button"
							onClick={ () => setIsConfirmOpen( false ) }
						>
							{ __( 'Cancel', 'newspack-nodes' ) }
						</button>
						<button
							type="button"
							className="button button-link-delete"
							onClick={ confirmRevoke }
						>
							{ __( 'Revoke', 'newspack-nodes' ) }
						</button>
					</div>
				</Modal>
			) }
		</td>
	);
}

/**
 * One issued session: its label, scope, timestamps and a Revoke button.
 *
 * Every listed row is live: `Sessions::listing()` lists a session only while
 * its row in the session store stands, and reads each fact from that row.
 *
 * @param {Object}   props
 * @param {Object}   props.session  A row from the view model.
 * @param {?Object}  props.answer   This row's last answer, or null.
 * @param {boolean}  props.busy     Whether a revoke of this row is outstanding.
 * @param {Function} props.onRevoke Revoke callback, taking the row's handle.
 * @return {import('react').ReactElement} The rendered row.
 */
function SessionRow( { session, answer, busy, onRevoke } ) {
	const { handle, label, scope, expires, created } = session;
	return (
		<tr data-session-handle={ handle }>
			<td>
				{ label || <em>{ __( '(unlabelled)', 'newspack-nodes' ) }</em> }
			</td>
			<td>
				<ScopeBadge scope={ scope } />
			</td>
			<td>{ when( created ) }</td>
			<td>{ when( expires ) }</td>
			<RevokeCell
				id={ handle }
				answer={ answer }
				busy={ busy }
				onRevoke={ onRevoke }
				title={ __( 'Revoke session', 'newspack-nodes' ) }
				warning={ __(
					'Revoking stops this key verifying immediately. Anything holding it will need a new one.',
					'newspack-nodes'
				) }
			/>
		</tr>
	);
}

/**
 * One OAuth connection: the name its approver gave it, the name its client
 * registered, its scope, when it was approved and expires, and a Revoke
 * button. A connection lists whether or not it holds a live session, and
 * revoking it ends the grant and every session it minted.
 *
 * @param {Object}   props
 * @param {Object}   props.connection A row from the view model.
 * @param {?Object}  props.answer     This row's last answer, or null.
 * @param {boolean}  props.busy       Whether a revoke of this row is outstanding.
 * @param {Function} props.onRevoke   Revoke callback, taking the grant id.
 * @return {import('react').ReactElement} The rendered row.
 */
function ConnectionRow( { connection, answer, busy, onRevoke } ) {
	const { grant, name, client, scope, created, expires } = connection;
	return (
		<tr data-connection-grant={ grant }>
			<td>{ name }</td>
			<td>{ client || '—' }</td>
			<td>
				<ScopeBadge scope={ scope } />
			</td>
			<td>{ when( created ) }</td>
			<td>{ when( expires ) }</td>
			<RevokeCell
				id={ grant }
				answer={ answer }
				busy={ busy }
				onRevoke={ onRevoke }
				title={ __( 'Revoke connection', 'newspack-nodes' ) }
				warning={ __(
					'Revoking ends this connection and every session it minted. The client must sign in again to reconnect.',
					'newspack-nodes'
				) }
			/>
		</tr>
	);
}

/**
 * A listing table: its header row, then its rows, or one row saying it is
 * empty.
 *
 * @param {Object}                         props
 * @param {string}                         props.className Names which listing it is.
 * @param {Array<[string, string]>}        props.columns   Each header and its width.
 * @param {string}                         props.empty     What an empty listing says.
 * @param {import('react').ReactElement[]} props.rows      The rows.
 * @return {import('react').ReactElement} The table.
 */
function ListTable( { className, columns, empty, rows } ) {
	return (
		<table className={ `newspack-nodes-table ${ className }` }>
			<thead>
				<tr>
					{ columns.map( ( [ header, width ] ) => (
						<th key={ header } style={ { width } }>
							{ header }
						</th>
					) ) }
				</tr>
			</thead>
			<tbody>
				{ rows.length > 0 ? (
					rows
				) : (
					<tr>
						<td colSpan={ columns.length }>{ empty }</td>
					</tr>
				) }
			</tbody>
		</table>
	);
}

/**
 * How the form hands a create over: the three fields the `create` verb takes,
 * the label already trimmed and the lifetime already a number, so the caller
 * only has to spell them as arguments.
 *
 * @typedef {(fields:{label:string,scope:string,ttl:number})=>void} CreateHandler
 */

/**
 * The create dialog: a label, a scope and a lifetime, handed to `onCreate`.
 * The dialog is the form, so Enter in a field issues, as the button does.
 *
 * The label is validated here and only here — an unlabelled mint works, but
 * `Sessions::issue()` declines to list it, so the operator would leave with a
 * key and no row to revoke it from. Every other refusal comes from the server and
 * arrives as the answer this form shows.
 *
 * Success does not close the dialog. The parent swaps it for the key dialog,
 * because the create answer is the one place the key is disclosed.
 *
 * @param {Object}                 props
 * @param {CreateHandler}          props.onCreate Receives the validated fields.
 * @param {?Object}                props.answer   The answer for the submitted label, if any.
 * @param {boolean}                props.busy     Whether the create is outstanding.
 * @param {() => void}             props.onCancel Dismisses the modal.
 * @param {Object<string, string>} props.scopes   Each scope the `list` verb serves, with its label.
 * @param {number}                 props.ttlMax   Server-side TTL ceiling, in seconds.
 * @return {import('react').ReactElement} The dialog.
 */
function CreateSessionModal( {
	onCreate,
	answer,
	busy,
	onCancel,
	scopes,
	ttlMax,
} ) {
	const [ label, setLabel ] = useState( '' );
	const [ picked, setScope ] = useState( '' );
	const names = Object.keys( scopes );
	const scope =
		picked ||
		( names.includes( DEFAULT_SCOPE ) ? DEFAULT_SCOPE : names[ 0 ] ?? '' );
	const [ ttl, setTtl ] = useState( String( DEFAULT_TTL_S ) );
	// Local validation only; the answer supplies everything else.
	const [ invalid, setInvalid ] = useState( '' );
	const labelRef = useRef( null );

	const status = invalid
		? invalid
		: answerStatus( answer, CREATE_TEXTS, busy ).text;

	useEffect( () => {
		labelRef.current?.focus();
	}, [] );

	const handleCreate = () => {
		const trimmed = label.trim();
		if ( ! trimmed ) {
			setInvalid(
				__(
					'A label is required — it is how you will recognise this later.',
					'newspack-nodes'
				)
			);
			return;
		}
		setInvalid( '' );
		onCreate( { label: trimmed, scope, ttl: Number( ttl ) } );
	};

	return (
		<Modal
			ariaLabel={ __( 'Issue a session', 'newspack-nodes' ) }
			onClose={ onCancel }
			onSubmit={ handleCreate }
		>
			<h4 className="newspack-nodes-modal__title">
				{ __( 'Issue a Session', 'newspack-nodes' ) }
			</h4>
			<table className="form-table" style={ { maxWidth: '600px' } }>
				<tbody>
					<tr>
						<th>
							<label htmlFor="new-session-label">
								{ __( 'Label', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								ref={ labelRef }
								type="text"
								id="new-session-label"
								className="regular-text"
								placeholder="laptop mcp client"
								value={ label }
								onChange={ ( e ) => setLabel( e.target.value ) }
							/>
						</td>
					</tr>
					<tr>
						<th>
							<label htmlFor="new-session-scope">
								{ __( 'Scope', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<select
								id="new-session-scope"
								value={ scope }
								onChange={ ( e ) => setScope( e.target.value ) }
							>
								{ names.map( ( s ) => (
									<option key={ s } value={ s }>
										{ s }
									</option>
								) ) }
							</select>
							<p className="description">{ scopes[ scope ] }</p>
							<p className="description">
								{ __(
									'A scope is a ceiling: it can only subtract from what your own account may do.',
									'newspack-nodes'
								) }
							</p>
						</td>
					</tr>
					<tr>
						<th>
							<label htmlFor="new-session-ttl">
								{ __( 'Lifetime (seconds)', 'newspack-nodes' ) }
							</label>
						</th>
						<td>
							<input
								type="number"
								id="new-session-ttl"
								min="60"
								max={ ttlMax || undefined }
								value={ ttl }
								onChange={ ( e ) => setTtl( e.target.value ) }
							/>
							<p className="description">
								{ __(
									'The key stays recoverable while it lives — verification recomputes an HMAC from it — so keep this short.',
									'newspack-nodes'
								) }
							</p>
						</td>
					</tr>
				</tbody>
			</table>
			<div className="newspack-nodes-modal__actions">
				<span className="newspack-nodes-status">{ status }</span>
				<button type="button" className="button" onClick={ onCancel }>
					{ __( 'Cancel', 'newspack-nodes' ) }
				</button>
				<button
					type="submit"
					className={ primaryButtonClass( busy ) }
					id="newspack-nodes-create-session"
					disabled={ busy }
				>
					{ __( 'Issue Session', 'newspack-nodes' ) }
				</button>
			</div>
		</Modal>
	);
}

/**
 * The one-time credential disclosure, rendered in place of the create dialog
 * once a session is issued. Closing is final: the listing never carries the
 * secret and no verb hands it back, so a lost credential is re-issued rather
 * than recovered.
 *
 * Handle and secret are shown joined by a dot, so one copy carries both. The
 * wire keeps them apart — the handle names the session in the `auth` envelope,
 * the secret signs it.
 *
 * @param {Object}     props
 * @param {Object}     props.session The mint: handle, secret, scope and `expires_in`.
 * @param {() => void} props.onClose Dismisses the modal.
 * @return {import('react').ReactElement} The dialog.
 */
function IssuedKeyModal( { session, onClose } ) {
	return (
		<Modal
			ariaLabel={ __( 'Session key', 'newspack-nodes' ) }
			onClose={ onClose }
		>
			<h4 className="newspack-nodes-modal__title">
				{ __( 'Session key', 'newspack-nodes' ) }
			</h4>
			<p>
				{ __(
					'Copy this now. It is shown once and cannot be recovered from the listing.',
					'newspack-nodes'
				) }
			</p>
			<p>
				<code className="nodes-sessions__key">
					{ session.handle }.{ session.secret }
				</code>
			</p>
			<p className="description">
				{ sprintf(
					// translators: 1: scope name, 2: lifetime in seconds.
					__(
						'Scope %1$s, expires in %2$d seconds.',
						'newspack-nodes'
					),
					session.scope,
					session.expires_in
				) }
			</p>
			<div className="newspack-nodes-modal__actions">
				<button
					type="button"
					className={ primaryButtonClass( false ) }
					onClick={ onClose }
				>
					{ __( 'Done', 'newspack-nodes' ) }
				</button>
			</div>
		</Modal>
	);
}

/**
 * Issued-session admin app: the table, the create modal and the key panel.
 *
 * The local state is what the graph cannot hold: whether the modal is open,
 * the session the last create disclosed, the label that create was sent with,
 * and each row's last answer. The label is state because an answer comes back
 * under the subject it was sent as, and a create's subject is its label.
 *
 * @param {Object}  props
 * @param {Element} [props.headerControlsSlot] Station header slot to portal the controls into.
 * @return {import('react').ReactElement} The rendered admin app.
 */
export default function SessionsAdmin( { headerControlsSlot } ) {
	const [ isCreateOpen, setIsCreateOpen ] = useState( false );
	// Disclosed once, so the create hands the key over, never publishes it.
	const [ issued, setIssued ] = useState( null );
	const [ submitted, setSubmitted ] = useState( null );
	// @longform Each row's last answer, put there BY the reply that named it.
	// Not a correlation table: the graph did the matching in the ADDRESS,
	// before this screen saw it — which is why a row keeps its line when a
	// sibling is revoked.
	const [ answers, setAnswers ] = useState( {} );
	const {
		sessions,
		connections,
		scopes,
		ttlMax,
		error,
		createSession,
		revoke,
		pendingVerb,
	} = useSessionsGraph( {
		onAnswer: ( { verb, subject, error: refusal, result } ) => {
			setAnswers( ( prior ) => ( {
				...prior,
				[ subject ]: { verb, error: refusal },
			} ) );
			// A create's own answer is what discloses the key, once.
			if ( 'create' === verb && ! refusal ) {
				setIssued( result );
			}
		},
	} );

	const closeCreate = () => {
		setIsCreateOpen( false );
		setIssued( null );
	};

	const controls = (
		<button
			type="button"
			className="nodes-cards__new button"
			onClick={ () => setIsCreateOpen( true ) }
		>
			{ __( '+ Issue Session', 'newspack-nodes' ) }
		</button>
	);

	return (
		<div className="nodes-sessions">
			{ error && (
				<div className="newspack-nodes-error-banner">
					<p>{ error }</p>
				</div>
			) }
			<HeaderSlot slot={ headerControlsSlot }>{ controls }</HeaderSlot>
			<h3>{ __( 'Issued sessions', 'newspack-nodes' ) }</h3>
			<ListTable
				className="nodes-sessions__sessions"
				columns={ [
					[ __( 'Label', 'newspack-nodes' ), '30%' ],
					[ __( 'Scope', 'newspack-nodes' ), '12%' ],
					[ __( 'Issued', 'newspack-nodes' ), '20%' ],
					[ __( 'Expires', 'newspack-nodes' ), '20%' ],
					[ __( 'Actions', 'newspack-nodes' ), '18%' ],
				] }
				empty={ __( 'No sessions issued.', 'newspack-nodes' ) }
				rows={ ( sessions ?? [] ).map( ( session ) => (
					<SessionRow
						key={ session.handle }
						session={ session }
						answer={ answers[ session.handle ] ?? null }
						busy={ Boolean( pendingVerb( session.handle ) ) }
						onRevoke={ revoke }
					/>
				) ) }
			/>
			<h3>{ __( 'Connections', 'newspack-nodes' ) }</h3>
			<ListTable
				className="nodes-sessions__connections"
				columns={ [
					[ __( 'Connection', 'newspack-nodes' ), '20%' ],
					[ __( 'Client', 'newspack-nodes' ), '18%' ],
					[ __( 'Scope', 'newspack-nodes' ), '10%' ],
					[ __( 'Approved', 'newspack-nodes' ), '18%' ],
					[ __( 'Expires', 'newspack-nodes' ), '18%' ],
					[ __( 'Actions', 'newspack-nodes' ), '16%' ],
				] }
				empty={ __( 'No connections approved.', 'newspack-nodes' ) }
				rows={ ( connections ?? [] ).map( ( connection ) => (
					<ConnectionRow
						key={ connection.grant }
						connection={ connection }
						answer={ answers[ connection.grant ] ?? null }
						busy={ Boolean( pendingVerb( connection.grant ) ) }
						onRevoke={ revoke }
					/>
				) ) }
			/>

			{ isCreateOpen && issued && (
				<IssuedKeyModal session={ issued } onClose={ closeCreate } />
			) }
			{ isCreateOpen && ! issued && (
				<CreateSessionModal
					onCreate={ ( fields ) => {
						setSubmitted( fields.label );
						createSession( fields );
					} }
					answer={ answers[ submitted ] ?? null }
					busy={ 'create' === pendingVerb( submitted ) }
					onCancel={ closeCreate }
					scopes={ scopes }
					ttlMax={ ttlMax }
				/>
			) }
		</div>
	);
}

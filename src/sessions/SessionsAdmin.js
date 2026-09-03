/**
 * <SessionsAdmin> — the React view over the issued-session node graph.
 *
 * Vault's mirror: Vault lists the credentials this site sends OUT, this lists
 * the ones it hands to callers coming IN — an agent's MCP client, a script on
 * a laptop. `useSessionsGraph` owns the data and the transport, so every
 * component here is presentation over the model that hook returns and over the
 * two verbs it exposes.
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

/**
 * What each scope admits, in the operator's words rather than `Capabilities`'.
 *
 * Keyed by the scope names the `list` verb serves, which is where the picker
 * gets its options too. A scope added on the server therefore still reaches
 * the picker; it renders with an empty description until it is named here.
 */
const SCOPE_BLURB = {
	read: __(
		'Dashboards and read-only verbs. Changes nothing.',
		'newspack-nodes'
	),
	tune: __(
		'Read, plus declared configuration and rules.',
		'newspack-nodes'
	),
	manage: __(
		'Everything, including the fleet and the vault.',
		'newspack-nodes'
	),
};

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
 * No `ok` text: `Sessions::forget()` drops the directory row, so a revoke that
 * succeeds takes away the line the confirmation would have been written on.
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
 * One issued session: its label, scope, state, timestamps and a Revoke button.
 *
 * The row owns no answer state. A revoke answers once, naming its handle, and
 * the graph keeps that answer per handle, so a row keeps its own line while a
 * sibling is revoked in the same second.
 *
 * The state badge says `live` or `revoked` and never `expired`, because
 * `Sessions::all()` prunes lapsed rows before it lists. A listed row that is
 * not live therefore lost its lease early — to a revoke whose directory write
 * failed, or to a salt rotation orphaning every key on the install.
 *
 * @param {Object}   props
 * @param {Object}   props.session  A row from the view model.
 * @param {?Object}  props.answer   This row's last answer, or null.
 * @param {boolean}  props.busy     Whether a revoke of this row is outstanding.
 * @param {Function} props.onRevoke Revoke callback, taking the row's handle.
 * @return {import('react').ReactElement} The rendered row.
 */
function SessionRow( { session, answer, busy, onRevoke } ) {
	const { handle, label, scope, expires, created, live, state } = session;
	const [ isConfirmOpen, setIsConfirmOpen ] = useState( false );
	const status = answerStatus( answer, REVOKE_TEXTS, busy ).text;

	const confirmRevoke = () => {
		setIsConfirmOpen( false );
		onRevoke( handle );
	};

	return (
		<tr data-session-handle={ handle }>
			<td>
				{ label || <em>{ __( '(unlabelled)', 'newspack-nodes' ) }</em> }
			</td>
			<td>
				<span
					className={ `newspack-nodes-badge nodes-sessions__scope is-${ scope }` }
				>
					{ scope }
				</span>
			</td>
			<td>
				<span
					className={ `newspack-nodes-status ${
						live ? 'is-success' : 'is-error'
					}` }
				>
					{ /* Not live means revoked: lapsed rows never list. */ }
					{ 'live' === state
						? __( 'live', 'newspack-nodes' )
						: __( 'revoked', 'newspack-nodes' ) }
				</span>
				{ status && (
					<div className="nodes-sessions__row-status">{ status }</div>
				) }
			</td>
			<td>{ when( created ) }</td>
			<td>{ when( expires ) }</td>
			<td>
				<button
					type="button"
					className="button button-small button-link-delete"
					disabled={ busy }
					onClick={ () => setIsConfirmOpen( true ) }
				>
					{ __( 'Revoke', 'newspack-nodes' ) }
				</button>
				{ isConfirmOpen && (
					<Modal
						ariaLabel={ __( 'Revoke session', 'newspack-nodes' ) }
						onClose={ () => setIsConfirmOpen( false ) }
					>
						<p>
							{ __(
								'Revoking stops this key verifying immediately. Anything holding it will need a new one.',
								'newspack-nodes'
							) }
						</p>
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
		</tr>
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
 * The create form: a label, a scope and a lifetime, handed to `onCreate`.
 *
 * The label is validated here and only here — an unlabelled mint works, but
 * `Sessions::record()` declines to list it, so the operator would leave with a
 * key and no row to revoke it from. Every other refusal is the server's and
 * arrives as the answer this form shows.
 *
 * Success does not close the modal. The parent swaps this form for the key
 * panel, because the create answer is the one place the key is disclosed.
 *
 * @param {Object}        props
 * @param {CreateHandler} props.onCreate Receives the validated fields.
 * @param {?Object}       props.answer   The answer for the submitted label, if any.
 * @param {boolean}       props.busy     Whether the create is outstanding.
 * @param {() => void}    props.onCancel Dismisses the modal.
 * @param {string[]}      props.scopes   Scope vocabulary from the view model.
 * @param {number}        props.ttlMax   Server-side TTL ceiling, in seconds.
 * @return {import('react').ReactElement} The rendered form.
 */
function CreateSessionForm( {
	onCreate,
	answer,
	busy,
	onCancel,
	scopes,
	ttlMax,
} ) {
	const [ label, setLabel ] = useState( '' );
	const [ scope, setScope ] = useState( scopes[ 0 ] ?? 'read' );
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
		<>
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
								{ scopes.map( ( s ) => (
									<option key={ s } value={ s }>
										{ s }
									</option>
								) ) }
							</select>
							<p className="description">
								{ SCOPE_BLURB[ scope ] }
							</p>
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
					type="button"
					className={ primaryButtonClass( busy ) }
					id="newspack-nodes-create-session"
					disabled={ busy }
					onClick={ handleCreate }
				>
					{ __( 'Issue Session', 'newspack-nodes' ) }
				</button>
			</div>
		</>
	);
}

/**
 * The one-time key disclosure, rendered in place of the form once a session is
 * issued. Closing is final: the listing never carries the key and no verb
 * hands it back, so a lost key is re-issued rather than recovered.
 *
 * Handle and key are shown joined by a dot, so one copy carries both. The wire
 * keeps them apart — the handle names the session in the `auth` envelope, the
 * key signs it.
 *
 * @param {Object}     props
 * @param {Object}     props.session The mint: handle, key, scope and `expires_in`.
 * @param {() => void} props.onClose Dismisses the modal.
 * @return {import('react').ReactElement} The panel.
 */
function IssuedKeyPanel( { session, onClose } ) {
	return (
		<>
			<p>
				{ __(
					'Copy this now. It is shown once and cannot be recovered from the listing.',
					'newspack-nodes'
				) }
			</p>
			<p>
				<code className="nodes-sessions__key">
					{ session.handle }.{ session.key }
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
		</>
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
 * @param {Element} [props.headerControlsSlot] Hub header slot to portal the controls into.
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
		scopes,
		ttlMax,
		error,
		createSession,
		revokeSession,
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
			<table className="newspack-nodes-table">
				<thead>
					<tr>
						<th style={ { width: '26%' } }>
							{ __( 'Label', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '12%' } }>
							{ __( 'Scope', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '14%' } }>
							{ __( 'State', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '18%' } }>
							{ __( 'Issued', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '18%' } }>
							{ __( 'Expires', 'newspack-nodes' ) }
						</th>
						<th style={ { width: '12%' } }>
							{ __( 'Actions', 'newspack-nodes' ) }
						</th>
					</tr>
				</thead>
				<tbody>
					{ sessions && sessions.length > 0 ? (
						sessions.map( ( session ) => (
							<SessionRow
								key={ session.handle }
								session={ session }
								answer={ answers[ session.handle ] ?? null }
								busy={ Boolean(
									pendingVerb( session.handle )
								) }
								onRevoke={ revokeSession }
							/>
						) )
					) : (
						<tr>
							<td colSpan={ 6 }>
								{ __(
									'No sessions issued.',
									'newspack-nodes'
								) }
							</td>
						</tr>
					) }
				</tbody>
			</table>

			{ isCreateOpen && (
				<Modal
					ariaLabel={ __( 'Issue a session', 'newspack-nodes' ) }
					onClose={ closeCreate }
				>
					<h4 className="newspack-nodes-modal__title">
						{ issued
							? __( 'Session key', 'newspack-nodes' )
							: __( 'Issue a Session', 'newspack-nodes' ) }
					</h4>
					{ issued ? (
						<IssuedKeyPanel
							session={ issued }
							onClose={ closeCreate }
						/>
					) : (
						<CreateSessionForm
							onCreate={ ( fields ) => {
								setSubmitted( fields.label );
								createSession( fields );
							} }
							answer={ answers[ submitted ] ?? null }
							busy={ 'create' === pendingVerb( submitted ) }
							onCancel={ closeCreate }
							scopes={
								scopes.length
									? scopes
									: [ 'read', 'tune', 'manage' ]
							}
							ttlMax={ ttlMax }
						/>
					) }
				</Modal>
			) }
		</div>
	);
}

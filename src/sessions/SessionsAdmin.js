/**
 * <SessionsAdmin> — the thin React view over the issued-session node graph.
 *
 * Vault's mirror: Vault lists the credentials this site sends OUT, this lists
 * the ones it hands to callers coming IN — an agent's MCP client, a script on
 * a laptop. The graph (useSessionsGraph) owns the data and the transport; this
 * component reads the view model via `useNodeState('sessions:list','view')`.
 *
 * The key is disclosed exactly once, in the create response, because the
 * verifier recomputes an HMAC from it and it therefore cannot be stored as a
 * digest. That is also why the TTL ceiling is bounded rather than optional.
 */

import { useEffect, useRef, useState, createPortal } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';

import { useNodeState } from '../runtime/react';
import { LIST_VIEW, useSessionsGraph } from './hooks/useSessionsGraph';
import Modal from '@newspack-nodes/shared/components/Modal';
import { primaryButtonClass } from '@newspack-nodes/shared/utils/buttonClass';
import './sessions-admin.scss';

// The view model before the first list publishes one — drives the loading gate.
const EMPTY_MODEL = {
	sessions: null,
	scopes: [],
	ttlMax: 0,
	loading: true,
	error: null,
};

/** What each scope actually admits, in the operator's words. */
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

const DEFAULT_TTL_S = 3600;

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
 * One issued session — label / scope / liveness / expiry + Revoke. Owns its own
 * status line, since a failed revoke leaves the row on screen with nothing else
 * to say so.
 *
 * @param {Object}   props
 * @param {Object}   props.session     A row from the view model.
 * @param {Function} props.onRevoke    Revoke callback (handle).
 * @param {Object}   props.revokeState Last revoke answer: `{ seq, subject, error }`.
 * @return {import('react').ReactElement} The rendered row.
 */
function SessionRow( { session, onRevoke, revokeState } ) {
	const { handle, label, scope, expires, created, live } = session;
	const [ status, setStatus ] = useState( '' );
	const [ busy, setBusy ] = useState( false );
	const [ isConfirmOpen, setIsConfirmOpen ] = useState( false );

	// The revoke's answer names its handle; that is how this row knows.
	const seenRef = useRef( 0 );
	useEffect( () => {
		if (
			revokeState.subject !== handle ||
			revokeState.seq === seenRef.current
		) {
			return;
		}
		seenRef.current = revokeState.seq;
		setBusy( false );
		if ( revokeState.error ) {
			setStatus(
				sprintf(
					// translators: %s: revocation error message.
					__( 'Revoke failed: %s', 'newspack-nodes' ),
					revokeState.error
				)
			);
		}
	}, [ revokeState, handle ] );

	const confirmRevoke = () => {
		setIsConfirmOpen( false );
		setBusy( true );
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
					{ live
						? __( 'live', 'newspack-nodes' )
						: __( 'expired', 'newspack-nodes' ) }
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
 * The create form. On success it hands the issued key back to the caller for
 * one-time display rather than closing straight away — the key is never
 * recoverable from the listing.
 *
 * @param {Object}     props
 * @param {Function}   props.onCreate    Create callback (fields).
 * @param {Object}     props.createState Last create answer: `{ seq, subject, result, error }`.
 * @param {Function}   props.onIssued    Called with the issued session.
 * @param {() => void} props.onCancel    Dismisses the modal.
 * @param {string[]}   props.scopes      Scope vocabulary from the view model.
 * @param {number}     props.ttlMax      Server-side TTL ceiling, in seconds.
 * @return {import('react').ReactElement} The rendered form.
 */
function CreateSessionForm( {
	onCreate,
	createState,
	onIssued,
	onCancel,
	scopes,
	ttlMax,
} ) {
	const [ label, setLabel ] = useState( '' );
	const [ scope, setScope ] = useState( scopes[ 0 ] ?? 'read' );
	const [ ttl, setTtl ] = useState( String( DEFAULT_TTL_S ) );
	const [ status, setStatus ] = useState( '' );
	const [ busy, setBusy ] = useState( false );
	const labelRef = useRef( null );
	// The label this form submitted, so it recognises its own answer.
	const submittedRef = useRef( null );
	const seenRef = useRef( 0 );

	useEffect( () => {
		labelRef.current?.focus();
	}, [] );

	const handleCreate = () => {
		const trimmed = label.trim();
		if ( ! trimmed ) {
			setStatus(
				__(
					'A label is required — it is how you will recognise this later.',
					'newspack-nodes'
				)
			);
			return;
		}
		setBusy( true );
		setStatus( __( 'Issuing…', 'newspack-nodes' ) );
		submittedRef.current = trimmed;
		onCreate( { label: trimmed, scope, ttl: Number( ttl ) } );
	};

	// The key rides the create's own answer, named by its label.
	useEffect( () => {
		if (
			createState.subject !== submittedRef.current ||
			createState.seq === seenRef.current
		) {
			return;
		}
		seenRef.current = createState.seq;
		setBusy( false );
		if ( createState.error ) {
			setStatus(
				sprintf(
					// translators: %s: error message.
					__( 'Error: %s', 'newspack-nodes' ),
					createState.error
				)
			);
			return;
		}
		onIssued( createState.result );
	}, [ createState, onIssued ] );

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
 * The one-time key disclosure. Rendered in place of the form once a session is
 * issued; there is no way back to it.
 *
 * @param {Object}     props
 * @param {Object}     props.session The issued session.
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
 * Issued-session admin app.
 *
 * @param {Object}  props
 * @param {Element} [props.headerControlsSlot] Hub header slot to portal the controls into.
 * @return {import('react').ReactElement} The rendered admin app.
 */
export default function SessionsAdmin( { headerControlsSlot } ) {
	const { createSession, revokeSession, createResult, revokeResult } =
		useSessionsGraph();

	const model = useNodeState( LIST_VIEW, 'view' ) ?? EMPTY_MODEL;
	const { sessions, scopes, ttlMax, error } = model;

	const [ isCreateOpen, setIsCreateOpen ] = useState( false );
	const [ issued, setIssued ] = useState( null );

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
	let renderedControls = null;
	if ( headerControlsSlot ) {
		renderedControls = createPortal( controls, headerControlsSlot );
	} else if ( undefined === headerControlsSlot ) {
		renderedControls = controls;
	}

	return (
		<div className="nodes-sessions">
			{ error && (
				<div className="newspack-nodes-error-banner">
					<p>{ error }</p>
				</div>
			) }
			{ renderedControls }
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
								onRevoke={ revokeSession }
								revokeState={ revokeResult }
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
							onCreate={ createSession }
							createState={ createResult }
							onIssued={ setIssued }
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

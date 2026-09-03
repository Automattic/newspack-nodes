/**
 * TriageView — the dead-letter queue of the selected consumer-family node, shown
 * inside the Inspector's wide Triage modal. It dispatches the hidden `dl_list` /
 * `dl_show` / `dl_requeue` / `dl_purge` verbs at that node's `:config`
 * interpreter through `onAction`, and renders the `dl_list` page as a table of
 * quarantined records carrying per-row View and Requeue buttons.
 *
 * Each verb mints its command FROM its OWN receiver node, so the reply lands
 * there and the addressing IS the correlation (ADR-7). One shared receiver would
 * hold one callback, and a `dl_show` dispatched while a `dl_list` was still in
 * flight would overwrite the callback waiting for the list.
 *
 * Every reply is read defensively, because it crosses the wire from a worker: a
 * refusal arrives as a TM_ERROR line, and a success body can still be malformed
 * JSON. Both belong in the status line rather than thrown out of the dispatch
 * that delivered them.
 */

import {
	Fragment,
	useCallback,
	useEffect,
	useRef,
	useState,
} from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { CallbackNode } from '../../runtime/callback-node';
import { TYPE, VALUE, TM_ERROR, payloadOf } from '../../runtime/message';
import { formatMessageEnvelope } from '../../runtime/dumper-node';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import './triage-view.scss';

/**
 * What the panel shows for a record.
 *
 * An `unparseable` record has no envelope of its own: poison_from_line() mints
 * a fresh TM_BYTESTREAM wrapper and puts the raw line in its VALUE, so the
 * VALUE *is* the whole original message and the wrapper is noise. Every other
 * reason preserves the real envelope, rendered by the Dumper exactly as the
 * REPL prints it — dl_show's keyed reply is regrouped into the positional
 * message it came from, so there is one message rendering, not two.
 *
 * @param {{type:number,timestamp:number,from:string,to:string,id:string,key:string,value:*}} record Decoded `dl_show` reply.
 * @param {string}                                                                            reason Quarantine reason from the dl_list row.
 * @return {string} Body text.
 */
function recordBody( record, reason ) {
	if ( 'unparseable' === reason ) {
		return String( record.value );
	}
	// Rebuilt as the positional array it was on disk (ADR-2), in field order.
	return formatMessageEnvelope( [
		record.type,
		record.timestamp,
		record.from,
		record.to,
		record.id,
		record.key,
		record.value,
	] );
}

/**
 * Decode a `dl_list` reply into the model the table renders.
 *
 * A body that is not JSON, or JSON carrying no `rows` array, sets `parseError`
 * instead of throwing, so a worker answering something unexpected costs the
 * operator a status line rather than the modal. `total` counts every indexed
 * record the node holds, not the rows in this page, which is what makes it the
 * badge number.
 *
 * @param {*} payload The reply payload, a JSON string when the verb succeeded.
 * @return {{rows:Array<Object>,total:number,unindexed:number,parseError:boolean}} The page, empty when the reply could not be read.
 */
function parseList( payload ) {
	let data = null;
	try {
		data = JSON.parse( String( payload ?? '' ) );
	} catch ( e ) {
		return { rows: [], total: 0, unindexed: 0, parseError: true };
	}
	if ( ! data || ! Array.isArray( data.rows ) ) {
		return { rows: [], total: 0, unindexed: 0, parseError: true };
	}
	return {
		rows: data.rows,
		total: Number( data.total ) || 0,
		unindexed: Number( data.unindexed_segments ) || 0,
		parseError: false,
	};
}

/**
 * The Triage modal body: the node's quarantined records, over Refresh and a
 * two-click Purge.
 *
 * The table is fetched on mount, whenever the inspected node changes, and after
 * each mutating verb — never on a timer. A dead-letter queue changes when a
 * message dies or an operator acts, and a background refetch would close the
 * record panel and disarm the purge confirmation under the hands of whoever
 * opened them.
 *
 * @param {Object}   props
 * @param {Object}   props.node     The selected node; only `id` is read, as the verb destination.
 * @param {Function} props.onAction Console action dispatcher — `( action, nodeId, payload )`.
 * @return {import('react').ReactElement} The triage modal body.
 */
export default function TriageView( { node, onAction } ) {
	// null = loading; else the parsed dl_list page.
	const [ data, setData ] = useState( null );
	// The last ok/error line from a verb reply, { text, isError } or null.
	const [ status, setStatus ] = useState( null );
	// Whether Purge is armed, waiting on its confirming second click.
	const [ confirmPurge, setConfirmPurge ] = useState( false );
	// The open record panel, { locator, record, body }, or null when closed.
	const [ shown, setShown ] = useState( null );
	// dl_show in flight; every View button is disabled until it replies.
	const [ viewPending, setViewPending ] = useState( false );

	// The latest onAction, read at dispatch rather than captured per render.
	const onActionRef = useRef( onAction );
	onActionRef.current = onAction;
	// Drop reply callbacks that land after the modal closes (no stray refetch).
	const mountedRef = useRef( true );
	useEffect( () => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, [] );

	// One receiver node per verb; see the file header.
	const receiversRef = useRef( null );
	if ( null === receiversRef.current ) {
		receiversRef.current = {};
	}
	/**
	 * The reply address for one verb, mounting its receiver on first use.
	 *
	 * The receiver is a `CallbackNode` named `_triage:<verb>`, and it reads the
	 * verb's current `onReply` at delivery rather than capturing one, so the
	 * callback that ran is always the one the latest dispatch installed.
	 *
	 * @param {string} verb The dead-letter verb this receiver answers for.
	 * @return {string} The receiver's node name, sent as the command's `replyTo`.
	 */
	const replyNodeFor = useCallback( ( verb ) => {
		const name = `_triage:${ verb }`;
		if ( ! receiversRef.current[ verb ] ) {
			const receiver = new CallbackNode( ( message ) => {
				const handler = receiversRef.current[ verb ]?.onReply;
				if ( ! handler || ! mountedRef.current ) {
					return;
				}
				const value = message[ VALUE ];
				const payload = payloadOf( value );
				handler( payload, !! ( message[ TYPE ] & TM_ERROR ) );
			} );
			receiver.name = name;
			receiversRef.current[ verb ] = { node: receiver, onReply: null };
		}
		return name;
	}, [] );

	// Free the names, or the next modal's receiver throws a collision.
	useEffect(
		() => () => {
			Object.values( receiversRef.current || {} ).forEach( ( entry ) => {
				entry.node?.removeNode?.();
			} );
			receiversRef.current = {};
		},
		[]
	);

	/**
	 * Dispatch one dead-letter verb at the node's `:config` interpreter.
	 *
	 * Reading `onAction` through its ref is what pins this callback's identity.
	 * The console hands down a fresh dispatcher on every poll, and a `runVerb`
	 * that changed with it would refetch the list on each one.
	 *
	 * @param {string}                                   verb       Verb name, `dl_list`, `dl_show`, `dl_requeue` or `dl_purge`.
	 * @param {string}                                   positional The verb's positional arguments; empty when it takes none.
	 * @param {Object}                                   byName     The same arguments keyed by argument name.
	 * @param {(payload: any, isError: boolean) => void} onReply    Runs on the reply, unless the modal has closed.
	 */
	const runVerb = useCallback(
		( verb, positional, byName, onReply ) => {
			const replyTo = replyNodeFor( verb );
			receiversRef.current[ verb ].onReply = onReply;
			onActionRef.current?.( 'invoke', node.id, {
				verb,
				kind: 'command',
				positional,
				byName,
				replyTo,
			} );
		},
		[ node.id, replyNodeFor ]
	);

	/**
	 * Refetch the page, dropping what the previous one anchored.
	 *
	 * An open record panel and an armed purge both belong to the page they were
	 * opened on: the panel's locator may no longer resolve, and a purge
	 * confirmed against a stale count is not the purge the operator agreed to.
	 */
	const refresh = useCallback( () => {
		setConfirmPurge( false );
		setShown( null );
		runVerb( 'dl_list', '', {}, ( payload, isError ) => {
			if ( isError ) {
				setStatus( { text: String( payload ?? '' ), isError: true } );
				return;
			}
			setData( parseList( payload ) );
		} );
	}, [ runVerb ] );

	// A ref, so a re-created dispatcher cannot retrigger this fetch.
	const refreshRef = useRef( refresh );
	refreshRef.current = refresh;
	useEffect( () => {
		refreshRef.current();
	}, [ node.id ] );

	/**
	 * Open the record panel for one row, or report why it stayed closed.
	 *
	 * The body is formatted once here, not per render, so re-rendering the table
	 * never re-parses an envelope. `reason` rides in from the row because it
	 * decides what the panel shows — see `recordBody`.
	 *
	 * @param {string} locator The record's `segment:offset:length` in the sidecar.
	 * @param {string} reason  Quarantine reason from the row.
	 */
	const view = ( locator, reason ) => {
		setConfirmPurge( false );
		setViewPending( true );
		runVerb( 'dl_show', locator, { locator }, ( payload, isError ) => {
			setViewPending( false );
			if ( isError ) {
				setStatus( { text: String( payload ?? '' ), isError: true } );
				return;
			}
			let record = null;
			try {
				record = JSON.parse( String( payload ?? '' ) );
			} catch ( e ) {
				record = null;
			}
			if ( ! record || 'object' !== typeof record ) {
				setStatus( {
					text: __(
						'Could not decode the record.',
						'newspack-nodes'
					),
					isError: true,
				} );
				return;
			}
			setShown( { locator, record, body: recordBody( record, reason ) } );
		} );
	};

	/**
	 * Redeliver one record to the node's sink, then refetch.
	 *
	 * `dl_requeue` answers an `ok:` or `error:` line instead of throwing, so the
	 * status line takes the reply either way. The quarantined copy stays put,
	 * which is why the refetched page still lists the row.
	 *
	 * @param {string} locator The record's `segment:offset:length` in the sidecar.
	 */
	const requeue = ( locator ) => {
		setConfirmPurge( false );
		runVerb( 'dl_requeue', locator, { locator }, ( payload, isError ) => {
			setStatus( { text: String( payload ?? '' ), isError } );
			refresh();
		} );
	};

	/**
	 * Arm the purge on the first click and send `dl_purge` on the second.
	 *
	 * `dl_purge` unlinks every dead-letter segment, so the confirmation lives in
	 * the button itself rather than a second modal over this one.
	 */
	const purge = () => {
		if ( ! confirmPurge ) {
			setConfirmPurge( true );
			return;
		}
		setConfirmPurge( false );
		runVerb( 'dl_purge', '', {}, ( payload, isError ) => {
			setStatus( { text: String( payload ?? '' ), isError } );
			refresh();
		} );
	};

	const rows = data?.rows ?? [];
	const total = data?.total ?? 0;
	const unindexed = data?.unindexed ?? 0;
	const parseError = !! data?.parseError;
	const loading = null === data;

	return (
		<div className="triage-view" data-testid="triage-view">
			<div className="triage-view__header">
				<span className="triage-view__node">{ node.id }</span>
				<span className="triage-view__total">
					{ loading
						? __( 'Loading…', 'newspack-nodes' )
						: sprintf(
								// translators: %d: number of quarantined records.
								__( '%d quarantined', 'newspack-nodes' ),
								total
						  ) }
				</span>
				{ unindexed > 0 && (
					<span className="triage-view__unindexed">
						{ sprintf(
							// translators: %d: count of records predating indexing.
							__(
								'%d older records predate indexing — replay via wp nodes ingest',
								'newspack-nodes'
							),
							unindexed
						) }
					</span>
				) }
			</div>

			{ parseError && (
				<div className="newspack-nodes-status triage-view__status is-error">
					{ __(
						'Could not read the dead-letter queue.',
						'newspack-nodes'
					) }
				</div>
			) }

			{ status && (
				<div
					className={ `newspack-nodes-status triage-view__status${
						status.isError ? ' is-error' : ''
					}` }
				>
					{ status.text }
				</div>
			) }

			{ ! loading && ! parseError && 0 === rows.length && (
				<div className="newspack-nodes-empty-state triage-view__empty">
					{ __( 'No quarantined records.', 'newspack-nodes' ) }
				</div>
			) }

			{ rows.length > 0 && (
				<table
					className="newspack-nodes-table nodes-runtime__grid triage-view__grid"
					data-testid="triage-grid"
				>
					<thead>
						<tr>
							<th className="nodes-runtime__th">
								{ __( 'TIME', 'newspack-nodes' ) }
							</th>
							<th className="nodes-runtime__th">
								{ __( 'REASON', 'newspack-nodes' ) }
							</th>
							<th className="nodes-runtime__th">
								{ __( 'ATTEMPTS', 'newspack-nodes' ) }
							</th>
							<th className="nodes-runtime__th">
								{ __( 'SOURCE', 'newspack-nodes' ) }
							</th>
							<th className="nodes-runtime__th">
								{ __( 'LOCATOR', 'newspack-nodes' ) }
							</th>
							<th className="nodes-runtime__th" />
						</tr>
					</thead>
					<tbody>
						{ rows.map( ( r, i ) => (
							<Fragment key={ r.locator ?? i }>
								<tr className="nodes-runtime__row">
									<td className="nodes-runtime__td">
										{ formatLocalDateTime( r.ts ) }
									</td>
									<td className="nodes-runtime__td">
										{ r.reason }
									</td>
									<td className="nodes-runtime__td">
										{ r.attempts }
									</td>
									<td className="nodes-runtime__td">
										{ r.source }
									</td>
									<td className="nodes-runtime__td">
										<code>{ r.locator }</code>
									</td>
									<td className="nodes-runtime__td">
										<button
											type="button"
											className="button is-compact"
											disabled={ viewPending }
											onClick={ () =>
												shown?.locator === r.locator
													? setShown( null )
													: view(
															r.locator,
															r.reason
													  )
											}
										>
											{ shown?.locator === r.locator
												? __( 'Hide', 'newspack-nodes' )
												: __(
														'View',
														'newspack-nodes'
												  ) }
										</button>
										<button
											type="button"
											className="button is-compact"
											onClick={ () =>
												requeue( r.locator )
											}
										>
											{ __(
												'Requeue',
												'newspack-nodes'
											) }
										</button>
									</td>
								</tr>
								{ shown?.locator === r.locator && (
									<tr className="nodes-runtime__row triage-view__record-row">
										<td
											className="nodes-runtime__td"
											colSpan={ 6 }
										>
											<pre
												className="triage-view__record"
												data-testid="triage-record"
											>
												{ shown.body }
											</pre>
										</td>
									</tr>
								) }
							</Fragment>
						) ) }
					</tbody>
				</table>
			) }

			<div className="triage-view__footer">
				<button type="button" className="button" onClick={ refresh }>
					{ __( 'Refresh', 'newspack-nodes' ) }
				</button>
				<button
					type="button"
					className={ `button${ confirmPurge ? ' is-danger' : '' }` }
					onClick={ purge }
				>
					{ confirmPurge
						? __( 'Confirm purge', 'newspack-nodes' )
						: __( 'Purge', 'newspack-nodes' ) }
				</button>
			</div>
		</div>
	);
}

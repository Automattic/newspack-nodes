/**
 * TriageView — the selected consumer/tail/remote-source node's dead-letter queue,
 * shown inside the Inspector's wide Triage modal. It dispatches the `dl_list` /
 * `dl_show` / `dl_requeue` / `dl_purge` verbs at the node's `:config`
 * interpreter via onAction. `dl_list` replies a JSON string, parsed defensively
 * into the table so a bad reply shows an error row, not a crash.
 *
 * Each verb mints its command FROM its OWN receiver node, so the reply lands
 * there and the addressing IS the correlation (ADR-7). This used to arm a
 * one-shot capture slot on the shared `_output` Dumper and match the reply by
 * command NAME — a single field, so a second verb overwrote the first's
 * callback, which is why a `viewPending` flag had to forbid a concurrent
 * `dl_show`.
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
import { TYPE, VALUE, TM_ERROR } from '../../runtime/message';
import { formatLocalDateTime } from '@newspack-nodes/shared/utils/formatUtils';
import './triage-view.scss';

// Parse the dl_list JSON reply; a malformed/shapeless reply flags parseError.
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
 * @param {Object}   props
 * @param {Object}   props.node     The selected node ({ id }).
 * @param {Function} props.onAction Console action dispatcher (fires the invoke).
 * @return {import('react').ReactElement} The triage modal body.
 */
export default function TriageView( { node, onAction } ) {
	// null = loading; else the parsed dl_list page.
	const [ data, setData ] = useState( null );
	// The last ok/error line from a verb reply, { text, isError } or null.
	const [ status, setStatus ] = useState( null );
	// Two-click purge: first click arms this, second click fires dl_purge.
	const [ confirmPurge, setConfirmPurge ] = useState( false );
	// The open record panel, { locator, record } from dl_show, or null.
	const [ shown, setShown ] = useState( null );
	// dl_show in flight, so the row's View button can show progress.
	const [ viewPending, setViewPending ] = useState( false );

	// Ref to the latest onAction keeps runVerb stable across polls.
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
	const replyNodeFor = useCallback( ( verb ) => {
		const name = `_triage:${ verb }`;
		if ( ! receiversRef.current[ verb ] ) {
			const receiver = new CallbackNode( ( message ) => {
				const handler = receiversRef.current[ verb ]?.onReply;
				if ( ! handler || ! mountedRef.current ) {
					return;
				}
				const value = message[ VALUE ];
				const payload =
					value && 'object' === typeof value ? value.payload : value;
				handler( payload, !! ( message[ TYPE ] & TM_ERROR ) );
			} );
			receiver.name = name;
			receiversRef.current[ verb ] = { node: receiver, onReply: null };
		}
		return name;
	}, [] );

	// Tear down with the modal, or a later one inherits the names.
	useEffect(
		() => () => {
			Object.values( receiversRef.current || {} ).forEach( ( entry ) => {
				entry.node?.removeNode?.();
			} );
			receiversRef.current = {};
		},
		[]
	);

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

	const refresh = useCallback( () => {
		// Any explicit refetch disarms a pending purge confirmation + panel.
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

	// Fetch on mount and whenever the inspected node changes — NOT per poll.
	const refreshRef = useRef( refresh );
	refreshRef.current = refresh;
	useEffect( () => {
		refreshRef.current();
	}, [ node.id ] );

	const view = ( locator ) => {
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
			setShown( { locator, record } );
		} );
	};

	const requeue = ( locator ) => {
		setConfirmPurge( false );
		runVerb( 'dl_requeue', locator, { locator }, ( payload, isError ) => {
			setStatus( { text: String( payload ?? '' ), isError } );
			refresh();
		} );
	};

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
													: view( r.locator )
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
												{ JSON.stringify(
													shown.record,
													null,
													2
												) }
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

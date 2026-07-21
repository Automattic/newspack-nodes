/**
 * TriageView — the selected consumer/tail/remote-source node's dead-letter queue,
 * shown inside the Inspector's wide Triage modal. It arms a one-shot reply capture
 * on the `_output` Dumper (the same round-trip the live-save flow uses), then
 * dispatches the `dl_list` / `dl_requeue` / `dl_purge` verbs at the node's
 * `:config` interpreter via onAction. `dl_list` replies a JSON string, parsed
 * defensively into the table so a bad reply shows an error row, not a crash.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import names from '../../runtime/reserved-node-names.json';
import './triage-view.scss';

// Record ts (epoch seconds) → UTC HH:MM:SS, like TimelineView.
function formatTime( ts ) {
	if ( 'number' !== typeof ts || ! Number.isFinite( ts ) ) {
		return '—';
	}
	return new Date( ts * 1000 ).toISOString().slice( 11, 19 );
}

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

	// Arm the one-shot `_output` reply capture, then dispatch the verb.
	const runVerb = useCallback(
		( verb, positional, byName, onReply ) => {
			Core.node( names.OUTPUT )?.captureNextReply(
				verb,
				( payload, isError ) => {
					if ( mountedRef.current ) {
						onReply( payload, isError );
					}
				}
			);
			onActionRef.current?.( 'invoke', node.id, {
				verb,
				kind: 'command',
				positional,
				byName,
			} );
		},
		[ node.id ]
	);

	const refresh = useCallback( () => {
		// Any explicit refetch disarms a pending purge confirmation.
		setConfirmPurge( false );
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
				<div className="triage-view__status is-error">
					{ __(
						'Could not read the dead-letter queue.',
						'newspack-nodes'
					) }
				</div>
			) }

			{ status && (
				<div
					className={ `triage-view__status${
						status.isError ? ' is-error' : ''
					}` }
				>
					{ status.text }
				</div>
			) }

			{ ! loading && ! parseError && 0 === rows.length && (
				<div className="triage-view__empty">
					{ __( 'No quarantined records.', 'newspack-nodes' ) }
				</div>
			) }

			{ rows.length > 0 && (
				<table
					className="nodes-runtime__grid triage-view__grid"
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
							<tr
								key={ r.locator ?? i }
								className="nodes-runtime__row"
							>
								<td className="nodes-runtime__td">
									{ formatTime( r.ts ) }
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
										onClick={ () => requeue( r.locator ) }
									>
										{ __( 'Requeue', 'newspack-nodes' ) }
									</button>
								</td>
							</tr>
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

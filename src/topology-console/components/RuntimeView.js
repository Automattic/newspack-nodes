/**
 * RuntimeView — a live view of the current scope's Event_Framework: its
 * registered timers and its cURL/EventSource handles, each as a click-to-sort
 * grid. A timer that is due every tick (NEXT <= 0) whose FIRES keep climbing is
 * a drain spinner — those rows are flagged red with a ⚠.
 *
 * Shown inside the Inspector's Runtime modal. It mounts ONE `Dmesg` poller (a
 * router-TIMER-hitchhiking TimerNode publishing an object reply as `reply`) on
 * the backbone while the modal is open, its verb retargeted at `runtime_stats`
 * and its poll routed through `_cwd` — so it reports the current scope
 * (browser-local at root, the cd'd worker when pivoted). The PHP and JS
 * `runtime_stats` verbs emit identical row keys, so it renders either unchanged.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';
import { Grid, useSortState } from './SortableGrid';
import './inspector-views.scss';

// The one poller node the view mounts + reads.
const POLLER = 'runtime:poller';

// Column specs per grid: numeric columns sort numerically (else lexically).
const TIMER_COLS = [
	{ key: 'id', label: 'ID', numeric: true },
	{ key: 'active', label: 'ACTIVE' },
	{ key: 'interval_ms', label: 'INTERVAL', numeric: true },
	{ key: 'mode', label: 'MODE' },
	{ key: 'next_ms', label: 'NEXT', numeric: true },
	{ key: 'oneshot', label: 'ONESHOT' },
	{ key: 'fires', label: 'FIRES', numeric: true },
	{ key: 'type', label: 'TYPE' },
	{ key: 'name', label: 'NAME' },
];
const HANDLE_COLS = [
	{ key: 'id', label: 'ID' },
	{ key: 'count', label: 'COUNT', numeric: true },
	{ key: 'type', label: 'TYPE' },
	{ key: 'name', label: 'NAME' },
];

/**
 * @param {Object}   props
 * @param {Function} [props.onAction] Console action dispatcher; the Trace toggle
 *                                    fires the all-nodes `trace` action through it.
 * @return {import('react').ReactElement} The Runtime modal view.
 */
export default function RuntimeView( { onAction } = {} ) {
	const [ timerSort, onTimerSort ] = useSortState( 'name' );
	const [ handleSort, onHandleSort ] = useSortState( 'name' );
	// Bumped after mount so useNodeState rebinds to the freshly-created poller.
	const [ , bumpBuild ] = useState( 0 );
	const pollerRef = useRef( null );

	// Mount ONE poller on the backbone; poll runtime_stats at _cwd.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			const poller = interpreter.makeNode( 'Dmesg', POLLER );
			poller.verb = 'runtime_stats';
			poller.pollArgs = [];
			// `_cwd` routes to the current scope; default it to browser-local.
			if ( ! Core.node( names.CWD ) ) {
				interpreter.makeNode( 'Node', names.CWD );
			}
			poller.target = names.CWD;
			poller.setTimer(); // hitchhike the _router TIMER (Dmesg throttles to 10s)
			poller.fire(); // poll immediately
			pollerRef.current = poller;
			bumpBuild( ( n ) => n + 1 );
			return () => {
				pollerRef.current = null;
			};
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	const data = useNodeState( POLLER, 'reply' );
	const timers = data?.timers ?? [];
	const handles = data?.handles ?? [];

	// All-nodes Trace toggle; server truth = ANY node traced (metadata poll).
	const metadata = useNodeState( names.METADATA, 'metadata' );
	const serverTraceOn = ( metadata?.nodes ?? [] ).some(
		( n ) => n.debugState > 0
	);
	// Optimistic override; each metadata poll reconciles it (server wins).
	const [ traceOptimistic, setTraceOptimistic ] = useState( null );
	useEffect( () => setTraceOptimistic( null ), [ metadata ] );
	const traceOn = null !== traceOptimistic ? traceOptimistic : serverTraceOn;
	const toggleTrace = () => {
		setTraceOptimistic( ! traceOn );
		if ( onAction ) {
			onAction( 'trace', '*', traceOn ? 0 : 1 );
		}
	};

	// Spinner: fires climbing vs the prior poll; the ref guards StrictMode.
	const lastDataRef = useRef( null );
	const prevFiresRef = useRef( new Map() );
	const [ climbing, setClimbing ] = useState( () => new Set() );
	useEffect( () => {
		if ( lastDataRef.current === data ) {
			return;
		}
		lastDataRef.current = data;
		const next = new Map();
		const grew = new Set();
		for ( const t of data?.timers ?? [] ) {
			const fires = Number( t.fires ) || 0;
			next.set( t.name, fires );
			if (
				prevFiresRef.current.has( t.name ) &&
				fires > prevFiresRef.current.get( t.name )
			) {
				grew.add( t.name );
			}
		}
		prevFiresRef.current = next;
		setClimbing( grew );
	}, [ data ] );

	// Numeric NEXT <= 0 with a climbing FIRES = a drain spinner.
	const timerRowClass = ( r ) =>
		'number' === typeof r.next_ms &&
		r.next_ms <= 0 &&
		climbing.has( r.name )
			? ' nodes-runtime__row--spinner'
			: '';

	return (
		<div className="nodes-runtime" data-testid="runtime-view">
			<div className="nodes-runtime__toolbar">
				<button
					type="button"
					className={ `button is-compact${
						traceOn ? ' is-active' : ''
					}` }
					onClick={ toggleTrace }
					title={
						traceOn
							? __(
									'Stop tracing every node — `debug_state * 0`',
									'newspack-nodes'
							  )
							: __(
									'Trace every node — `debug_state * 1`',
									'newspack-nodes'
							  )
					}
				>
					{ traceOn
						? __( 'stop trace', 'newspack-nodes' )
						: __( 'trace', 'newspack-nodes' ) }
				</button>
			</div>
			<div className="nodes-runtime__section">
				<h3 className="nodes-runtime__title">
					{ __( 'Timers', 'newspack-nodes' ) }
				</h3>
				<Grid
					testid="runtime-timers"
					cols={ TIMER_COLS }
					rows={ timers }
					sort={ timerSort }
					onSort={ onTimerSort }
					rowClass={ timerRowClass }
				/>
			</div>
			<div className="nodes-runtime__section">
				<h3 className="nodes-runtime__title">
					{ __( 'Handles', 'newspack-nodes' ) }
				</h3>
				<Grid
					testid="runtime-handles"
					cols={ HANDLE_COLS }
					rows={ handles }
					sort={ handleSort }
					onSort={ onHandleSort }
				/>
			</div>
		</div>
	);
}

/**
 * RuntimeView — a live view of the current scope's Event_Framework: its
 * registered timers and its cURL/EventSource handles, each as a click-to-sort
 * grid. A timer due every tick (NEXT <= 0) whose FIRES keep climbing is a
 * drain spinner; those rows take the alert tint and a ⚠.
 *
 * Shown inside the Inspector's Runtime modal. It mounts TWO `Poller` nodes
 * (router-TIMER-hitchhiking TimerNodes publishing their reply as `reply`) on
 * the backbone while the modal is open — one per verb, `list_timers -s` and
 * `list_handles -s` — each routed through `_cwd` so it reports the current
 * scope: browser-local at root, the cd'd worker when pivoted. One node per
 * verb is the contract rather than a convenience — a reply comes back
 * addressed to the node that minted it, so nothing here correlates anything
 * (ADR-7) — and both mints still leave in the one POST the tick batches.
 *
 * `-s` hands back the same rows the text tables print, so the grid sorts
 * structured values instead of parsing a fixed-width table, and the REPL and
 * the grid cannot disagree about what a row means. The two scopes fill those
 * rows differently: PHP knows when each timer next fires and numbers its
 * handles, while the browser reports `next_ms` as null and puts the
 * EventSource readyState in the handle ID column. Spinner detection reads
 * `next_ms`, so it flags only in a worker scope.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';
import { Grid, useSortState } from './SortableGrid';
import './inspector-views.scss';

/** Registered name of the `list_timers` poller the timers grid reads. */
const TIMER_POLLER = 'runtime:timers';

/** Registered name of the `list_handles` poller the handles grid reads. */
const HANDLE_POLLER = 'runtime:handles';

/**
 * Timer grid columns, in `list_timers`' own order. A `numeric` column sorts by
 * value; lexically, FIRES 10 files between 1 and 2.
 */
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

/**
 * Handle grid columns, in `list_handles`' own order. ID is deliberately not
 * numeric: PHP hands back an integer handle id, the browser the EventSource
 * readyState label, and a numeric sort collapses every label to one value.
 */
const HANDLE_COLS = [
	{ key: 'id', label: 'ID' },
	{ key: 'count', label: 'COUNT', numeric: true },
	{ key: 'type', label: 'TYPE' },
	{ key: 'name', label: 'NAME' },
];

/**
 * Render the Runtime modal body: the current scope's timers and handles.
 *
 * @return {import('react').ReactElement} The Runtime modal view.
 */
export default function RuntimeView() {
	const [ timerSort, onTimerSort ] = useSortState( 'name' );
	const [ handleSort, onHandleSort ] = useSortState( 'name' );
	/**
	 * Bumped once the pollers exist. `useNodeState` resolves its node during
	 * render, and on the first render neither poller has been created yet, so
	 * without a re-render both grids would stay bound to nothing.
	 */
	const [ , bumpBuild ] = useState( 0 );
	/** The timers poller, set at mount and cleared on teardown. */
	const pollerRef = useRef( null );

	// Mount one poller per verb on the backbone; both poll at `_cwd`.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			// `_cwd` routes to the current scope; default it to browser-local.
			if ( ! Core.node( names.CWD ) ) {
				interpreter.makeNode( 'Node', names.CWD );
			}
			/**
			 * Build one poller, aim it at `_cwd`, and take its first reading.
			 *
			 * @param {string} name Name to register the poller under.
			 * @param {string} verb Interpreter verb it polls, always with `-s`.
			 * @return {import('../../runtime/poller-node').PollerNode} The poller.
			 */
			const mount = ( name, verb ) => {
				const poller = interpreter.makeNode( 'Poller', name );
				poller.verb = verb;
				poller.pollArgs = [ '-s' ];
				poller.target = names.CWD;
				poller.setTimer(); // ride the _router TIMER at pollIntervalMs
				poller.fire(); // a first reading now, not a cadence away
				return poller;
			};
			pollerRef.current = mount( TIMER_POLLER, 'list_timers' );
			mount( HANDLE_POLLER, 'list_handles' );
			bumpBuild( ( n ) => n + 1 );
			return () => {
				pollerRef.current = null;
			};
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Undefined until the first reply lands; the grids render empty.
	const data = useNodeState( TIMER_POLLER, 'reply' );
	const timers = Array.isArray( data ) ? data : [];
	const handleData = useNodeState( HANDLE_POLLER, 'reply' );
	const handles = Array.isArray( handleData ) ? handleData : [];

	/**
	 * The reply already folded into the baseline. StrictMode double-invokes
	 * this effect on the same reply, and a second fold would measure the poll
	 * against a baseline it had just written, clearing every flag.
	 */
	const lastDataRef = useRef( null );
	/** FIRES per timer name at the previous poll — the baseline a climb beats. */
	const prevFiresRef = useRef( new Map() );
	/** Timer names whose FIRES grew between the last two polls. */
	const [ climbing, setClimbing ] = useState( () => new Set() );
	useEffect( () => {
		if ( lastDataRef.current === data ) {
			return;
		}
		lastDataRef.current = data;
		const next = new Map();
		const grew = new Set();
		for ( const t of Array.isArray( data ) ? data : [] ) {
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

	/**
	 * The extra class for one timer row. A timer due every tick whose FIRES
	 * climbed since the last poll is spinning the drain loop; one with a
	 * future `next_ms` is doing its job, however fast it fires.
	 *
	 * The typeof guard is what leaves the browser scope unflagged: it reports
	 * `next_ms` as null for every timer, and `null <= 0` is true.
	 *
	 * @param {{name:string,next_ms:?number}} r One `list_timers -s` row.
	 * @return {string} The class to append, or '' for an ordinary row.
	 */
	const timerRowClass = ( r ) =>
		'number' === typeof r.next_ms &&
		r.next_ms <= 0 &&
		climbing.has( r.name )
			? ' nodes-runtime__row--spinner'
			: '';

	return (
		<div className="nodes-runtime" data-testid="runtime-view">
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

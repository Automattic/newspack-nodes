/**
 * RuntimeView — a live view of the current scope's Event_Framework: its
 * registered timers and its cURL/EventSource handles, each as a click-to-sort
 * grid. A timer that is due every tick (NEXT <= 0) whose FIRES keep climbing is
 * a drain spinner — those rows are flagged red with a ⚠.
 *
 * Shown inside the Inspector's Runtime modal. It mounts TWO `Poller` nodes
 * (router-TIMER-hitchhiking TimerNodes publishing their reply as `reply`) on the
 * backbone while the modal is open — one per verb, `list_timers -s` and
 * `list_handles -s` — each routed through `_cwd` so it reports the current scope
 * (browser-local at root, the cd'd worker when pivoted). `-s` hands back the
 * same rows the text tables print, so the grid sorts them without parsing a
 * fixed-width table, and PHP and JS render alike.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';
import { Grid, useSortState } from './SortableGrid';
import './inspector-views.scss';

// The poller nodes the view mounts + reads, one per verb.
const TIMER_POLLER = 'runtime:timers';
const HANDLE_POLLER = 'runtime:handles';

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

/** @return {import('react').ReactElement} The Runtime modal view. */
export default function RuntimeView() {
	const [ timerSort, onTimerSort ] = useSortState( 'name' );
	const [ handleSort, onHandleSort ] = useSortState( 'name' );
	// Bumped after mount so useNodeState rebinds to the freshly-created poller.
	const [ , bumpBuild ] = useState( 0 );
	const pollerRef = useRef( null );

	// Mount one poller per verb on the backbone; both poll at _cwd.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			// `_cwd` routes to the current scope; default it to browser-local.
			if ( ! Core.node( names.CWD ) ) {
				interpreter.makeNode( 'Node', names.CWD );
			}
			const mount = ( name, verb ) => {
				const poller = interpreter.makeNode( 'Poller', name );
				poller.verb = verb;
				poller.pollArgs = [ '-s' ];
				poller.target = names.CWD;
				poller.setTimer(); // hitchhike _router TIMER (Poller throttles)
				poller.fire(); // poll immediately
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

	const data = useNodeState( TIMER_POLLER, 'reply' );
	const timers = Array.isArray( data ) ? data : [];
	const handleData = useNodeState( HANDLE_POLLER, 'reply' );
	const handles = Array.isArray( handleData ) ? handleData : [];

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

	// Numeric NEXT <= 0 with a climbing FIRES = a drain spinner.
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

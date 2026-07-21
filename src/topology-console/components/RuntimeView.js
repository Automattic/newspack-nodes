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

import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import names from '../../runtime/reserved-node-names.json';
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

// One cell: booleans read yes/no; an absent value (JS next_ms/id) reads –.
function formatCell( value ) {
	if ( 'boolean' === typeof value ) {
		return value ? 'yes' : 'no';
	}
	if ( null === value || undefined === value ) {
		return '–';
	}
	return String( value );
}

// Sort a copy of rows by one column; numeric columns compare as numbers.
function sortRows( rows, cols, sort ) {
	const col = cols.find( ( c ) => c.key === sort.key );
	if ( ! col ) {
		return rows;
	}
	const factor = 'desc' === sort.dir ? -1 : 1;
	const num = ( v ) => {
		const n = Number( v );
		return Number.isNaN( n ) ? -Infinity : n;
	};
	return [ ...rows ].sort( ( a, b ) => {
		if ( col.numeric ) {
			return ( num( a[ col.key ] ) - num( b[ col.key ] ) ) * factor;
		}
		return (
			String( a[ col.key ] ?? '' ).localeCompare(
				String( b[ col.key ] ?? '' )
			) * factor
		);
	} );
}

/**
 * A click-to-sort grid. `rowClass( row )` returns an extra class (spinner flag);
 * when it fires, the row's first cell gets a ⚠ marker.
 *
 * @param {Object}   props
 * @param {string}   props.testid     Grid test id (headers get `${testid}-th-${key}`).
 * @param {Array}    props.cols       Column specs ({ key, label, numeric? }).
 * @param {Array}    props.rows       Keyed rows from runtime_stats.
 * @param {Object}   props.sort       { key, dir } sort state.
 * @param {Function} props.onSort     Called with a column key on header click.
 * @param {Function} [props.rowClass] Row → extra class name ('' for none).
 * @return {import('react').ReactElement} The grid table.
 */
function Grid( { testid, cols, rows, sort, onSort, rowClass } ) {
	const sorted = useMemo(
		() => sortRows( rows, cols, sort ),
		[ rows, cols, sort ]
	);
	// Sort-direction arrow for a column header ('' unless it's the sorted one).
	const arrow = ( c ) => {
		if ( sort.key !== c.key ) {
			return '';
		}
		return 'asc' === sort.dir ? ' ▲' : ' ▼';
	};
	return (
		<table className="nodes-runtime__grid" data-testid={ testid }>
			<thead>
				<tr>
					{ cols.map( ( c ) => (
						<th
							key={ c.key }
							data-testid={ `${ testid }-th-${ c.key }` }
							className={ `nodes-runtime__th${
								sort.key === c.key ? ' is-sorted' : ''
							}` }
							onClick={ () => onSort( c.key ) }
						>
							{ c.label }
							{ arrow( c ) }
						</th>
					) ) }
				</tr>
			</thead>
			<tbody>
				{ sorted.map( ( r, i ) => {
					const extra = rowClass ? rowClass( r ) : '';
					return (
						<tr
							key={ r.name ?? i }
							data-name={ r.name }
							className={ `nodes-runtime__row${ extra }` }
						>
							{ cols.map( ( c, ci ) => (
								<td key={ c.key } className="nodes-runtime__td">
									{ 0 === ci && extra ? '⚠ ' : '' }
									{ formatCell( r[ c.key ] ) }
								</td>
							) ) }
						</tr>
					);
				} ) }
			</tbody>
		</table>
	);
}

/**
 * @return {import('react').ReactElement} The Runtime modal view.
 */
export default function RuntimeView() {
	const [ timerSort, setTimerSort ] = useState( { key: 'name', dir: 'asc' } );
	const [ handleSort, setHandleSort ] = useState( {
		key: 'name',
		dir: 'asc',
	} );
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

	const onTimerSort = ( key ) =>
		setTimerSort( ( s ) => ( {
			key,
			dir: s.key === key && 'asc' === s.dir ? 'desc' : 'asc',
		} ) );
	const onHandleSort = ( key ) =>
		setHandleSort( ( s ) => ( {
			key,
			dir: s.key === key && 'asc' === s.dir ? 'desc' : 'asc',
		} ) );

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

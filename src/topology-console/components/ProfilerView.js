/**
 * ProfilerView — the Inspector's Profiler modal: the Router's per-node
 * self-time table, which is `list_profiles` and nothing else.
 *
 * It renders exactly the verb's columns (AVERAGE / TIME / COUNT / WINDOW /
 * RATE / AGE / WHAT), taken as rows via `-s` rather than parsed back out of the
 * fixed-width text — same derivation, so the grid and the REPL can never
 * disagree. `--total--` rides in as the last row and is pinned to the footer.
 *
 * One `Poller` node (a router-TIMER-hitchhiking TimerNode publishing its reply
 * as `reply`) is mounted on the backbone while the modal is open, routed
 * through `_cwd` so it reports the current scope — browser-local at root, the
 * cd'd worker when pivoted. PHP and JS emit the same keys, so either renders
 * unchanged. The toolbar sets profiling in that same scope, so one modal both
 * starts the measurement and reads it.
 */

import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { LIVE_POLL_INTERVAL_MS } from '../../runtime/poller-node';
import { useNodeField } from '../../runtime/react';
import { FROM, TO } from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';
import { Grid, useSortState } from './SortableGrid';
import './inspector-views.scss';

/**
 * The one poller node the view mounts and reads. `Core` is a per-page registry
 * every dashboard on the page shares, so the name is prefixed to keep it clear
 * of the other views' pollers.
 */
const POLLER = 'profiler:fetch';

/**
 * Format one numeric cell to a fixed number of decimals, as the verb's own text
 * table prints it.
 *
 * @param {number} places Decimals to keep.
 * @return {(v:number)=>string} The column's cell formatter.
 */
const fixed = ( places ) => ( v ) => v.toFixed( places );

/**
 * `list_profiles`' own columns, in its own order, at the decimals its text
 * table prints: AVERAGE to six, TIME, WINDOW and RATE to two. Everything but
 * WHAT sorts numerically on the raw value.
 */
const COLS = [
	{ key: 'avg', label: 'AVERAGE', numeric: true, format: fixed( 6 ) },
	{ key: 'time', label: 'TIME', numeric: true, format: fixed( 2 ) },
	{ key: 'count', label: 'COUNT', numeric: true },
	{ key: 'window', label: 'WINDOW', numeric: true, format: fixed( 2 ) },
	{ key: 'rate', label: 'RATE', numeric: true, format: fixed( 2 ) },
	{ key: 'age', label: 'AGE', numeric: true },
	{ key: 'what', label: 'WHAT' },
];

/**
 * One `list_profiles -s` row: the stats the verb derives from a raw profile
 * record, plus the node name — or `--total--` — in `what`.
 *
 * @typedef {import('../../runtime/command-interpreter-node').ProfileStats & {what:string}} ProfileRow
 */

/**
 * Mount the poller, render its rows as a sortable grid, and stand the
 * profiling control above them.
 *
 * @return {import('react').ReactElement} The Profiler modal view.
 */
export default function ProfilerView() {
	const [ sort, onSort ] = useSortState( 'avg', 'desc' );
	// Bumped after mount so useNodeField rebinds to the freshly-created poller.
	const [ , bumpBuild ] = useState( 0 );
	const pollerRef = useRef( null );
	const interpreterRef = useRef( null );

	useEffect( () => {
		const build = ( { interpreter } ) => {
			interpreterRef.current = interpreter;
			const poller = interpreter.makeNode( 'Poller', POLLER );
			poller.verb = 'list_profiles';
			poller.pollArgs = [ '-s' ];
			// `_cwd` routes to the current scope; default it to browser-local.
			if ( ! Core.node( names.CWD ) ) {
				interpreter.makeNode( 'Node', names.CWD );
			}
			poller.target = names.CWD;
			poller.pollIntervalMs = LIVE_POLL_INTERVAL_MS;
			poller.setTimer(); // hitchhike the _router TIMER (Poller throttles)
			poller.fire(); // poll immediately
			pollerRef.current = poller;
			bumpBuild( ( n ) => n + 1 );
			return () => {
				pollerRef.current = null;
				interpreterRef.current = null;
			};
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	const reply = useNodeField( POLLER, 'reply' );
	const all = Array.isArray( reply ) ? reply : null;
	// Profiling off answers with the --total-- row alone (count 0).
	const profilingOn = null !== all && all.length > 1;

	// Optimistic override; each poll reply reconciles it (server truth wins).
	const [ optimistic, setOptimistic ] = useState( null );
	// Override: agreement clears; one stale reply tolerated; two surrender.
	const disagreeRef = useRef( 0 );
	useEffect( () => {
		if ( null === optimistic ) {
			return;
		}
		if ( profilingOn === optimistic || disagreeRef.current >= 1 ) {
			disagreeRef.current = 0;
			setOptimistic( null );
			return;
		}
		disagreeRef.current += 1;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ reply ] );
	const showStop = null !== optimistic ? optimistic : profilingOn;

	/**
	 * Set profiling in the viewed scope, and show the new state on the click
	 * rather than a poll later: the button reads optimistically until a reply
	 * confirms or overrules it.
	 *
	 * Sends the explicit `profile on` / `profile off` rather than the bare
	 * toggle, because a toggle carries the reading it was clicked against — a
	 * stale one turns profiling off in the scope the operator meant to
	 * measure. The poller MINTS and signs the command; FROM and TO are written
	 * afterwards, since the signature covers the semantics alone (ADR-15).
	 * FROM is bare `_ui`: the button reads its answer off the next poll, and a
	 * reply landing on the poller would stand in for the rows. Firing the
	 * poller straight after puts that poll on this tick, not the next interval.
	 *
	 * @param {boolean} enable Whether profiling should run in that scope.
	 */
	const setProfiling = ( enable ) => {
		disagreeRef.current = 0;
		setOptimistic( enable );
		const interpreter = interpreterRef.current;
		if ( ! interpreter ) {
			return;
		}
		const verb = enable ? 'on' : 'off';
		const m = Core.node( POLLER )?.command( 'profile', [ verb ] );
		if ( ! m ) {
			return; // unauthenticated; re-auth is under way
		}
		m[ FROM ] = names.UI;
		m[ TO ] = names.CWD;
		Core.node( names.OUTPUT )?.appendUi( {
			kind: 'sent',
			text: `command_node ${ names.CWD } profile ${ verb }`,
		} );
		interpreter.fill( m );
		pollerRef.current?.fire();
	};

	const rows = useMemo(
		() => ( all ?? [] ).filter( ( r ) => '--total--' !== r.what ),
		[ all ]
	);
	const footer = useMemo(
		() => ( all ?? [] ).find( ( r ) => '--total--' === r.what ) ?? null,
		[ all ]
	);

	return (
		<div className="nodes-profiler" data-testid="profiler-view">
			<div className="nodes-profiler__toolbar">
				<button
					type="button"
					className={ `button is-compact${
						showStop ? ' is-active' : ''
					}` }
					onClick={ () => setProfiling( ! showStop ) }
				>
					{ showStop
						? __( 'stop profiling', 'newspack-nodes' )
						: __( 'profile', 'newspack-nodes' ) }
				</button>
			</div>
			<Grid
				testid="profiler-grid"
				cols={ COLS }
				rows={ rows }
				sort={ sort }
				onSort={ onSort }
				footer={ footer }
			/>
		</div>
	);
}

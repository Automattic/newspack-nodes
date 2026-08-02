/**
 * ProfilerView — the Inspector's Profiler modal: the Router's per-node
 * self-time table, which is `list_profiles` and nothing else.
 *
 * It renders exactly the verb's columns (AVERAGE / TIME / COUNT / WINDOW /
 * RATE / AGE / WHAT), taken as rows via `-s` rather than parsed back out of the
 * fixed-width text — same derivation, so the grid and the REPL can never
 * disagree. `--total--` rides in as the last row and is pinned to the footer.
 *
 * One `Dmesg` poller (a router-TIMER-hitchhiking TimerNode publishing its reply
 * as `reply`) is mounted on the backbone while the modal is open, routed
 * through `_cwd` so it reports the current scope — browser-local at root, the
 * cd'd worker when pivoted. PHP and JS emit the same keys, so either renders
 * unchanged.
 */

import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import { TO } from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';
import { Grid, useSortState } from './SortableGrid';
import './inspector-views.scss';

// The one poller node the view mounts + reads.
const POLLER = 'profiler:poller';

// list_profiles' own columns, in its own order.
const COLS = [
	{ key: 'avg', label: 'AVERAGE', numeric: true },
	{ key: 'time', label: 'TIME', numeric: true },
	{ key: 'count', label: 'COUNT', numeric: true },
	{ key: 'window', label: 'WINDOW', numeric: true },
	{ key: 'rate', label: 'RATE', numeric: true },
	{ key: 'age', label: 'AGE', numeric: true },
	{ key: 'what', label: 'WHAT' },
];

// Fixed-decimal display, kept sortable: the numeric column Number()-parses it.
const fmt = ( v, places ) => Number( v ).toFixed( places );
const shape = ( r ) => ( {
	avg: fmt( r.avg, 6 ),
	time: fmt( r.time, 2 ),
	count: r.count,
	window: fmt( r.window, 2 ),
	rate: fmt( r.rate, 2 ),
	age: r.age,
	what: r.what,
} );

/** @return {import('react').ReactElement} The Profiler modal view. */
export default function ProfilerView() {
	const [ sort, onSort ] = useSortState( 'avg', 'desc' );
	// Bumped after mount so useNodeState rebinds to the freshly-created poller.
	const [ , bumpBuild ] = useState( 0 );
	const pollerRef = useRef( null );
	const interpreterRef = useRef( null );

	useEffect( () => {
		const build = ( { interpreter } ) => {
			interpreterRef.current = interpreter;
			const poller = interpreter.makeNode( 'Dmesg', POLLER );
			poller.verb = 'list_profiles';
			poller.pollArgs = [ '-s' ];
			// `_cwd` routes to the current scope; default it to browser-local.
			if ( ! Core.node( names.CWD ) ) {
				interpreter.makeNode( 'Node', names.CWD );
			}
			poller.target = names.CWD;
			poller.setTimer(); // hitchhike the _router TIMER (Dmesg throttles)
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

	const reply = useNodeState( POLLER, 'reply' );
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

	// Set profiling in the viewed scope via explicit `profile on`/`off`.
	const setProfiling = ( enable ) => {
		disagreeRef.current = 0;
		setOptimistic( enable );
		const interpreter = interpreterRef.current;
		if ( ! interpreter ) {
			return;
		}
		// The poller mints (FROM=its name, LOCAL, signed); TO after.
		const m = Core.node( POLLER )?.command( 'profile', [
			enable ? 'on' : 'off',
		] );
		if ( ! m ) {
			return; // unauthenticated; re-auth is under way
		}
		m[ TO ] = names.CWD;
		interpreter.fill( m );
		pollerRef.current?.fire();
	};

	const rows = useMemo(
		() =>
			( all ?? [] )
				.filter( ( r ) => '--total--' !== r.what )
				.map( shape ),
		[ all ]
	);
	const footer = useMemo( () => {
		const total = ( all ?? [] ).find( ( r ) => '--total--' === r.what );
		return total ? shape( total ) : null;
	}, [ all ] );

	return (
		<div className="nodes-stats" data-testid="profiler-view">
			<div className="nodes-stats__toolbar">
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

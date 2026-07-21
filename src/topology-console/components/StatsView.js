/**
 * StatsView — the "hot nodes" grid in the Inspector's Stats modal. Baseline
 * columns (NAME / COUNTER / LGST_MSG / READ / WRITTEN) come from the graph the
 * console ALREADY polls (`_metadata`); no new polling for those. Router profiling
 * (AVG / TIME / COUNT) is joined by node name from a runtime_stats poller mounted
 * only while the modal is open — RuntimeView's exact pattern. When profiling is
 * off an "Enable profiling" button turns it on in the viewed scope; on, "Disable
 * profiling" plus a distinct total row.
 * Grid rows = the metadata baseline; --total-- = the router aggregate
 * (includes scaffolding self-time absent from the visible rows).
 */

import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';
import { Grid, useSortState } from './SortableGrid';
import './inspector-views.scss';

// The one poller node the view mounts + reads (distinct from RuntimeView's).
const POLLER = 'stats:poller';

// Always-present baseline columns, read from the polled `_metadata` graph.
const BASE_COLS = [
	{ key: 'name', label: 'NAME' },
	{ key: 'counter', label: 'COUNTER', numeric: true },
	{ key: 'lgst_msg', label: 'LGST_MSG', numeric: true },
	{ key: 'read', label: 'READ', numeric: true },
	{ key: 'written', label: 'WRITTEN', numeric: true },
];
// Appended only while profiling is on; joined onto BASE_COLS by node name.
const PROFILE_COLS = [
	{ key: 'avg', label: 'AVG', numeric: true },
	{ key: 'time', label: 'TIME', numeric: true },
	{ key: 'count', label: 'COUNT', numeric: true },
];

// Fixed-decimal display, kept sortable: the numeric column Number()-parses it.
const fmtAvg = ( v ) => Number( v ).toFixed( 6 );
const fmtTime = ( v ) => Number( v ).toFixed( 2 );

/**
 * @return {import('react').ReactElement} The Stats modal view.
 */
export default function StatsView() {
	const [ sort, onSort ] = useSortState( 'name' );
	// Bumped after mount so useNodeState rebinds to the freshly-created poller.
	const [ , bumpBuild ] = useState( 0 );
	const pollerRef = useRef( null );
	const interpreterRef = useRef( null );

	// Mount ONE runtime_stats poller on the backbone; poll at _cwd.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			interpreterRef.current = interpreter;
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
				interpreterRef.current = null;
			};
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Baseline: the graph the console already polls — NOT a new poll.
	const metadata = useNodeState( names.METADATA, 'metadata' );
	// Profiling half: the runtime_stats reply this view's own poller publishes.
	const data = useNodeState( POLLER, 'reply' );
	const profiles = data?.profiles;
	const profilingOn = Array.isArray( profiles );

	// Send a scope command (enable/disable profiling) to _cwd, then re-poll.
	const sendScopeCommand = ( verb ) => {
		const interpreter = interpreterRef.current;
		if ( ! interpreter ) {
			return;
		}
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = POLLER;
		m[ TO ] = names.CWD;
		m[ VALUE ] = { name: verb, arguments: [] };
		m[ LOCAL ] = true;
		interpreter.fill( m );
		pollerRef.current?.fire();
	};

	const profileByName = useMemo( () => {
		const map = new Map();
		for ( const p of profiles ?? [] ) {
			map.set( p.name, p );
		}
		return map;
	}, [ profiles ] );

	const rows = useMemo(
		() =>
			( metadata?.nodes ?? [] ).map( ( n ) => {
				const row = {
					name: n.id,
					counter: n.count ?? 0,
					lgst_msg: n.lgstMsg ?? 0,
					read: n.bytesRead ?? 0,
					written: n.bytesWritten ?? 0,
				};
				const p = profileByName.get( n.id );
				if ( p ) {
					row.avg = fmtAvg( p.avg );
					row.time = fmtTime( p.time );
					row.count = p.count;
				}
				return row;
			} ),
		[ metadata, profileByName ]
	);

	const cols = useMemo(
		() => ( profilingOn ? [ ...BASE_COLS, ...PROFILE_COLS ] : BASE_COLS ),
		[ profilingOn ]
	);

	const total = data?.profiles_total;

	return (
		<div className="nodes-stats" data-testid="stats-view">
			<div className="nodes-stats__toolbar">
				{ profilingOn ? (
					<button
						type="button"
						className="button is-compact is-active"
						onClick={ () =>
							sendScopeCommand( 'disable_profiling' )
						}
					>
						{ __( 'Disable profiling', 'newspack-nodes' ) }
					</button>
				) : (
					<button
						type="button"
						className="button is-compact"
						onClick={ () => sendScopeCommand( 'enable_profiling' ) }
					>
						{ __( 'Enable profiling', 'newspack-nodes' ) }
					</button>
				) }
			</div>
			<Grid
				testid="stats-grid"
				cols={ cols }
				rows={ rows }
				sort={ sort }
				onSort={ onSort }
			/>
			{ profilingOn && total && (
				<div className="nodes-stats__total" data-testid="stats-total">
					<span className="nodes-stats__total-what">--total--</span>
					<span>avg { fmtAvg( total.avg ) }</span>
					<span>time { fmtTime( total.time ) }</span>
					<span>count { total.count }</span>
				</div>
			) }
		</div>
	);
}

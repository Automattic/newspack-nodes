/**
 * The Logs tab — the debug overlay's server/browser log tail. Three sources:
 * "This browser" (the JS runtime's own stderr ring, via the LOCAL `dmesg` verb),
 * "PHP error log", and "WP debug.log" (durable aggregated FILES the request-scope
 * `taillog` verb tails over `/command`). The overlay's pages have no attached
 * server process, so there is no server-process dmesg here.
 *
 * Wiring: ONE `Dmesg` poller (a router-TIMER-hitchhiking TimerNode that publishes
 * its reply text to `lines`) is mounted on the overlay backbone. Source selection
 * just retargets it — `dmesg` at the local interpreter for This browser, `taillog
 * <source>` over the `_http` boundary for the two files — and re-polls at once.
 * Chosen over useDashboardGraph/useBatchedPoll because the poller already IS the
 * poll loop; no view-node class, no setInterval, no slice fetchers.
 */

import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { mountExospine } from '../../runtime/exospine';
import { useNodeState } from '../../runtime/react';
import { classifyLine } from '../../runtime/dmesg-node';
import names from '../../runtime/reserved-node-names.json';

// The one poller node the tab mounts + reads.
const POLLER = 'logs:poller';

// Repin to the bottom after new lines only if scrolled within this of the end.
const PIN_THRESHOLD_PX = 24;

// The three fixed sources, in select order.
const SOURCES = [
	{ value: 'browser', label: __( 'This browser', 'newspack-nodes' ) },
	{ value: 'php', label: __( 'PHP error log', 'newspack-nodes' ) },
	{ value: 'debug', label: __( 'WP debug.log', 'newspack-nodes' ) },
];

// Level chips, in order; labels match the overview's err/warn/dbg convention.
const MSG_LEVELS = [
	{ level: 'error', label: __( 'err', 'newspack-nodes' ) },
	{ level: 'warning', label: __( 'warn', 'newspack-nodes' ) },
	{ level: 'debug', label: __( 'dbg', 'newspack-nodes' ) },
];

/**
 * Retarget the poller for a source. This browser reads the LOCAL `dmesg` verb
 * (empty target); the two files tail `taillog <source>` over the request-scope
 * `_http` boundary. A user change re-polls now; a rebuild waits for the tick.
 *
 * @param {Object}  poller The mounted Dmesg poller node.
 * @param {string}  source 'browser' | 'php' | 'debug'.
 * @param {boolean} fire   Re-poll immediately (user change) vs next tick.
 */
function configurePoller( poller, source, fire ) {
	if ( 'browser' === source ) {
		poller.verb = 'dmesg';
		poller.pollArgs = [];
		poller.target = '';
	} else {
		poller.verb = 'taillog';
		poller.pollArgs = [ source ];
		poller.target = names.HTTP;
	}
	if ( fire ) {
		poller.fire();
	}
}

/**
 * @param {Object}   props
 * @param {Function} props.publishHeader Publish header extras to the panel's shared Header (the Logs tab clears them — it has no cwd to navigate).
 * @return {import('react').ReactElement} The Logs tab.
 */
export default function LogsTab( { publishHeader } ) {
	const [ source, setSource ] = useState( 'browser' );
	const [ levels, setLevels ] = useState( {
		error: true,
		warning: true,
		debug: true,
	} );
	// Bumped after mount so useNodeState rebinds to the freshly-created poller.
	const [ , bumpBuild ] = useState( 0 );
	const pollerRef = useRef( null );
	const scrollRef = useRef( null );
	const pinnedRef = useRef( true );

	// The Logs tab owns no header controls — clear any the Console left behind.
	useEffect( () => publishHeader?.( null ), [ publishHeader ] );

	// Ref so a generation-bump rebuild re-applies the CURRENT source in build.
	const sourceRef = useRef( source );
	sourceRef.current = source;

	// Mount ONE poller on the overlay backbone; teardown on unmount.
	useEffect( () => {
		const build = ( { interpreter } ) => {
			const poller = interpreter.makeNode( 'Dmesg', POLLER );
			// Hitchhike the _router TIMER (Dmesg throttles itself to 10s).
			poller.setTimer();
			configurePoller( poller, sourceRef.current, false );
			pollerRef.current = poller;
			bumpBuild( ( n ) => n + 1 );
			return () => {
				pollerRef.current = null;
			};
		};
		const { teardown } = mountExospine( build );
		return teardown;
	}, [] );

	// Retarget + re-poll on a user source change.
	useEffect( () => {
		if ( pollerRef.current ) {
			configurePoller( pollerRef.current, source, true );
		}
	}, [ source ] );

	const raw = useNodeState( POLLER, 'lines' );

	// Split + classify each non-blank line (blank lines carry no level).
	const lines = useMemo(
		() =>
			String( raw || '' )
				.split( '\n' )
				.filter( ( line ) => '' !== line.trim() )
				.map( ( text ) => ( { text, level: classifyLine( text ) } ) ),
		[ raw ]
	);

	// Whether the viewport is pinned to the bottom (else the user scrolled up).
	const onScroll = () => {
		const el = scrollRef.current;
		if ( el ) {
			pinnedRef.current =
				el.scrollHeight - el.scrollTop - el.clientHeight <
				PIN_THRESHOLD_PX;
		}
	};

	// Auto-scroll to the bottom on new lines unless the user scrolled up.
	useEffect( () => {
		const el = scrollRef.current;
		if ( el && pinnedRef.current ) {
			el.scrollTop = el.scrollHeight;
		}
	}, [ lines, levels ] );

	return (
		<div className="nodes-logs" data-testid="logs-tab">
			<div className="nodes-logs__toolbar">
				<select
					className="nodes-logs__source"
					data-testid="logs-source"
					value={ source }
					onChange={ ( e ) => setSource( e.target.value ) }
				>
					{ SOURCES.map( ( s ) => (
						<option key={ s.value } value={ s.value }>
							{ s.label }
						</option>
					) ) }
				</select>
				<div className="nodes-logs__chips">
					{ MSG_LEVELS.map( ( { level, label } ) => (
						<button
							key={ level }
							type="button"
							data-testid={ `logs-chip-${ level }` }
							aria-pressed={ levels[ level ] }
							className={ `button button-small${
								levels[ level ] ? ' button-primary' : ''
							}` }
							onClick={ () =>
								setLevels( ( prev ) => ( {
									...prev,
									[ level ]: ! prev[ level ],
								} ) )
							}
						>
							{ label }
						</button>
					) ) }
				</div>
			</div>
			<ul
				ref={ scrollRef }
				onScroll={ onScroll }
				className="nodes-logs__lines"
				data-testid="logs-lines"
			>
				{ lines
					.filter( ( l ) => levels[ l.level ] )
					.map( ( l, i ) => (
						<li
							key={ i }
							className={ `nodes-logs__line nodes-logs__line--${ l.level }` }
						>
							{ l.text }
						</li>
					) ) }
			</ul>
		</div>
	);
}

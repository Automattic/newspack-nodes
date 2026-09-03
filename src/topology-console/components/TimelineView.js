/**
 * The DEBUG-trace timeline: the REPL transcript parsed into a filterable
 * node/event/payload table.
 *
 * A node whose `debug_state` is above zero (what the `trace` verb sets) emits
 * a `<node>: DEBUG: <event> <payload>` line on its stderr chain as it
 * publishes state — `Node::set_state()` in a worker, its `setState` mirror in
 * the browser — and those lines land in the `_output` transcript the REPL
 * already renders. This view is an alternate render of THAT array, not new
 * plumbing: it opens no stream and mounts no node, which is what lets it work
 * unchanged in the topology console, in the debug overlay's Console tab, and
 * while the console is cd'd into a worker.
 */

import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import './timeline-view.scss';

/**
 * One DEBUG trace line: the node name, the event, and an optional payload.
 *
 * Nothing anchors the front, so the match starts at the last space-free token
 * before ` DEBUG: ` and steps over the log prefix and process midfix the line
 * arrives carrying. That token is `\S+` rather than a name pattern so a
 * sidecar's own colons survive (`scored:consumer`, `combined.p0:crawler`), and
 * the payload runs to end of line, since the caller matches one line at a time.
 */
const DEBUG_TRACE = /(\S+):\s+DEBUG:\s+(\S+)(?:\s+(.*))?$/;

/**
 * Format an entry's timestamp as a local `HH:MM:SS` cell. The transcript
 * stamps `ts` browser-side, so the viewer's zone is the one that instant
 * belongs to — the zone `Core.log_prefix` puts on the lines beside it. A UTC
 * cell there would be two clocks describing one event.
 *
 * @param {number} ts Epoch seconds.
 * @return {string} `HH:MM:SS`, or an em dash when ts is not a finite number.
 */
function formatTime( ts ) {
	if ( 'number' !== typeof ts || ! Number.isFinite( ts ) ) {
		return '—';
	}
	const d = new Date( ts * 1000 );
	return [ d.getHours(), d.getMinutes(), d.getSeconds() ]
		.map( ( n ) => String( n ).padStart( 2, '0' ) )
		.join( ':' );
}

/**
 * Parse the transcript into timeline rows, keeping only the entries that carry
 * a DEBUG trace.
 *
 * Each entry is scanned line by line and the first match wins, so one entry
 * yields at most one row. Matching the whole text instead would capture across
 * lines: at verbosity 2 the Dumper renders the entire message envelope with
 * the trace riding its `value:` line, and the payload would swallow the
 * closing `}`.
 *
 * @param {Array<{key:string,ts:number,text:string}>} transcript Dumper transcript entries, oldest first.
 * @return {Array<{key:string,ts:number,node:string,event:string,payload:string}>} One row per traced entry, in transcript order.
 */
function parseRows( transcript ) {
	const rows = [];
	for ( const entry of transcript ) {
		let match = null;
		for ( const line of ( entry?.text ?? '' ).split( '\n' ) ) {
			match = DEBUG_TRACE.exec( line );
			if ( match ) {
				break;
			}
		}
		if ( ! match ) {
			continue;
		}
		rows.push( {
			key: entry.key,
			ts: entry.ts,
			node: match[ 1 ] ?? '',
			event: match[ 2 ],
			payload: match[ 3 ] ?? '',
		} );
	}
	return rows;
}

/**
 * Render the trace table under its two filters.
 *
 * Parsing runs on every render rather than behind a memo: the Dumper's
 * transcript is a bounded ring and every filter keystroke re-renders anyway,
 * so a cache would cost more than the scan it saves. Rows hold transcript
 * order, oldest first, because a trace is read as a sequence. Both filters are
 * case-insensitive substrings over one column each, and the empty state names
 * the Trace toggle, since a fleet with no traced node produces no rows at all.
 *
 * @param {Object}                                    props
 * @param {Array<{key:string,ts:number,text:string}>} [props.transcript] The Dumper transcript entries.
 * @param {import('react').ReactNode}                 [props.actions]    Controls rendered in line with the filter inputs (left side).
 * @return {import('react').ReactElement} The filter row plus the trace grid, or the empty state.
 */
export default function TimelineView( { transcript = [], actions = null } ) {
	const [ nodeFilter, setNodeFilter ] = useState( '' );
	const [ eventFilter, setEventFilter ] = useState( '' );

	const node = nodeFilter.trim().toLowerCase();
	const event = eventFilter.trim().toLowerCase();
	const rows = parseRows( transcript ).filter(
		( row ) =>
			( '' === node || row.node.toLowerCase().includes( node ) ) &&
			( '' === event || row.event.toLowerCase().includes( event ) )
	);

	return (
		<div className="timeline-view">
			<div className="timeline-view__filters">
				{ actions }
				<input
					type="text"
					className="timeline-view__filter"
					placeholder={ __( 'filter node…', 'newspack-nodes' ) }
					value={ nodeFilter }
					onChange={ ( ev ) => setNodeFilter( ev.target.value ) }
					aria-label={ __(
						'Filter timeline by node',
						'newspack-nodes'
					) }
				/>
				<input
					type="text"
					className="timeline-view__filter"
					placeholder={ __( 'filter event…', 'newspack-nodes' ) }
					value={ eventFilter }
					onChange={ ( ev ) => setEventFilter( ev.target.value ) }
					aria-label={ __(
						'Filter timeline by event',
						'newspack-nodes'
					) }
				/>
			</div>
			{ rows.length ? (
				// Fixed header outside the scroll body (shared grid).
				<div className="timeline-view__grid">
					<div className="timeline-view__head">
						<span className="timeline-view__col">
							{ __( 'Time', 'newspack-nodes' ) }
						</span>
						<span className="timeline-view__col">
							{ __( 'Node', 'newspack-nodes' ) }
						</span>
						<span className="timeline-view__col">
							{ __( 'Event', 'newspack-nodes' ) }
						</span>
						<span className="timeline-view__col">
							{ __( 'Payload', 'newspack-nodes' ) }
						</span>
					</div>
					<div className="timeline-view__body">
						{ rows.map( ( row ) => (
							<div key={ row.key } className="timeline-view__row">
								<span className="timeline-view__cell timeline-view__time">
									{ formatTime( row.ts ) }
								</span>
								<span className="timeline-view__cell timeline-view__node">
									{ row.node }
								</span>
								<span className="timeline-view__cell timeline-view__event">
									{ row.event }
								</span>
								<span className="timeline-view__cell timeline-view__payload">
									{ row.payload }
								</span>
							</div>
						) ) }
					</div>
				</div>
			) : (
				<p className="newspack-nodes-empty-state timeline-view__empty">
					{ __(
						'No traces yet — toggle Trace on a node (the Inspector’s Trace button) to populate the timeline.',
						'newspack-nodes'
					) }
				</p>
			) }
		</div>
	);
}

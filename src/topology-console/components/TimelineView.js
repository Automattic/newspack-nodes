/**
 * TimelineView — a parsed, filterable view over the REPL transcript's DEBUG
 * traces. When a node's debug_state is on it emits `<node>: DEBUG: <event>
 * <payload>` lines (Node::set_state → stderr) which land in the transcript;
 * this view parses those lines into a compact table. It is NOT new plumbing —
 * just an alternate render of the same transcript array, so it works in both
 * the topology console and the debug overlay Console tab, local or cd'd.
 */

import { useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import './timeline-view.scss';

// DEBUG line; node \S+ (sidecar colons survive); payload line-scoped (.*).
const DEBUG_TRACE = /(\S+):\s+DEBUG:\s+(\S+)(?:\s+(.*))?$/;

// Entry ts (epoch seconds) → UTC HH:MM:SS, matching the console's UTC logs.
function formatTime( ts ) {
	if ( 'number' !== typeof ts || ! Number.isFinite( ts ) ) {
		return '—';
	}
	return new Date( ts * 1000 ).toISOString().slice( 11, 19 );
}

// Keep DEBUG entries; scan per line so the verbose envelope `}` isn't captured.
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
 * @param {Object}                    props
 * @param {Array}                     props.transcript The Dumper transcript entries (`{ ts, kind, text, key }`).
 * @param {import('react').ReactNode} [props.actions]  Controls rendered in line with the filter inputs (left side).
 * @return {import('react').ReactElement} The timeline grid + filters.
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

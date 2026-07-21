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

// DEBUG line: required `<node>: ` midfix, the DEBUG: marker, event, payload.
const DEBUG_TRACE = /([^\s:]+):\s+DEBUG:\s+(\S+)(?:\s+([\s\S]*))?$/;

// Entry ts (epoch seconds) → UTC HH:MM:SS, matching the console's UTC logs.
function formatTime( ts ) {
	if ( 'number' !== typeof ts || ! Number.isFinite( ts ) ) {
		return '—';
	}
	return new Date( ts * 1000 ).toISOString().slice( 11, 19 );
}

// Keep only transcript entries matching the DEBUG convention, in order.
function parseRows( transcript ) {
	const rows = [];
	for ( const entry of transcript ) {
		const match = DEBUG_TRACE.exec( entry?.text ?? '' );
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
 * @param {Object} props
 * @param {Array}  props.transcript The Dumper transcript entries (`{ ts, kind, text, key }`).
 * @return {import('react').ReactElement} The timeline table + filters.
 */
export default function TimelineView( { transcript = [] } ) {
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
				<table className="timeline-view__table">
					<thead>
						<tr>
							<th>{ __( 'Time', 'newspack-nodes' ) }</th>
							<th>{ __( 'Node', 'newspack-nodes' ) }</th>
							<th>{ __( 'Event', 'newspack-nodes' ) }</th>
							<th>{ __( 'Payload', 'newspack-nodes' ) }</th>
						</tr>
					</thead>
					<tbody>
						{ rows.map( ( row ) => (
							<tr key={ row.key } className="timeline-view__row">
								<td className="timeline-view__time">
									{ formatTime( row.ts ) }
								</td>
								<td className="timeline-view__node">
									{ row.node }
								</td>
								<td className="timeline-view__event">
									{ row.event }
								</td>
								<td className="timeline-view__payload">
									{ row.payload }
								</td>
							</tr>
						) ) }
					</tbody>
				</table>
			) : (
				<p className="timeline-view__empty">
					{ __(
						'No traces yet — toggle Trace on a node (the Inspector’s Trace button) to populate the timeline.',
						'newspack-nodes'
					) }
				</p>
			) }
		</div>
	);
}

import { Core } from './core';

/**
 * Snapshot every registered node into a dump_metadata-shaped object keyed by
 * node name. Patron-linked nodes are plumbing and are skipped.
 *
 * @return {Object} Map of node name to { class, counter, sink, target, debug_state, arguments, lgst_msg, bytes_read, bytes_written }.
 */
export function dumpMetadataPayload() {
	const out = {};
	for ( const [ name, node ] of Core.nodes ) {
		// Patron-linked nodes are plumbing; the canvas shouldn't render them.
		if ( node.patron !== null && node.patron !== undefined ) {
			continue;
		}
		out[ name ] = {
			class: node.constructor?.name ?? 'Node',
			counter: node.counter ?? 0,
			sink: node.sink && node.sink.name ? node.sink.name : '',
			target: node.target ?? '',
			debug_state: node.debugState ?? 0,
			arguments: node.arguments ?? '',
			lgst_msg: node.largestMsgSent ?? 0,
			bytes_read: node.bytesRead ?? 0,
			bytes_written: node.bytesWritten ?? 0,
		};
	}
	return out;
}

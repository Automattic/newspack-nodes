/**
 * SseInNode — the SSE receive-ingress node.
 *
 * It is the runtime's SseConnector (opens the EventSource, snoops the
 * `connected` envelope for `pid()`), plus the incoming session routing: an SSE
 * reply/broadcast, the EventSource ingress, or a synchronous POST-body reply fed
 * back in. Strip our own `_sse:{pid}` head if present (the client-side mirror of
 * HTTP_Filter), stamp the `_sse/…` provenance breadcrumb, and route by TO
 * (`TO ||= target` = `_output` so broadcasts reach the transcript). FROM is the
 * responder, never a reply node.
 *
 * The outgoing reply-FROM wrap (`_sse:{pid}/{node}`) moved up into RemoteIpc,
 * which owns its own HttpOut and mints the worker-pivot send; SseIn is now
 * receive-only.
 */

import { SseConnectorNode } from './sse-connector-node';
import { TO } from './message';
import names from './reserved-node-names.json';

export class SseInNode extends SseConnectorNode {
	fill( message ) {
		// Incoming: strip our own session head (`_sse:{pid}`) if present — the
		// client-side HTTP_Filter for synchronous POST-body intake. (SSE-stream
		// replies are already stripped by the server's HTTP_Filter, so this is a
		// no-op for them.)
		const head = `${ names.SSE }:${ this.pid() }`;
		const to = message[ TO ];
		const slash = to.indexOf( '/' );
		if ( ( -1 === slash ? to : to.slice( 0, slash ) ) === head ) {
			message[ TO ] = -1 === slash ? '' : to.slice( slash + 1 );
		}
		// Stamp the breadcrumb so a wire-origin message is distinguishable from a
		// locally-minted one (FROM=`_sse/…`). Routing is by TO, so this is provenance only.
		this.stampMessage( message, this.name );
		super.fill( message );
	}
	// accepts_fill is a UI hint (can you wire a connection INTO it); SseIn has a fill() but isn't a drag-into target, so false.
	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Inbound SSE receive-ingress; composed by RemoteLink as `{name}:sse-in`.',
			accepts_fill: false,
			has_target: true,
			// Inherit the connector's positional args so the base setter still parses them.
			arguments: SseConnectorNode.nodeSchema().arguments,
			commands: [],
		};
	}
}

/**
 * SseInNode — the `_sse` console node: the bidirectional SSE session boundary.
 *
 * It is the runtime's SseConnector (opens the EventSource, snoops the
 * `connected` envelope for `pid()`), plus the session routing both legs go
 * through:
 *
 *  - Outgoing — a command routed in via TO=`_sse/…` (so `_router` peeled the
 *    `_sse` head). If FROM is a browser reply node (`_output`/`_metadata`/
 *    `_uptime`/`_completion`/`_heartbeat`) it's wrapped into the private reply
 *    pivot `_sse:{pid}/{from}`
 *    (the server's HTTP_In stamps the `_http/` boundary prefix on arrival), and
 *    `_http` is prepended to TO so it routes on to the `_http` node (HttpOut →
 *    POST) and the server's HTTP_Filter can demux the reply back to THIS session.
 *  - Incoming — an SSE reply/broadcast, the EventSource ingress, or a synchronous
 *    POST-body reply HttpOut feeds back in: strip our own `_sse:{pid}` head if
 *    present (the client-side mirror of HTTP_Filter), stamp the `_sse/…`
 *    provenance breadcrumb, and route by TO (`TO ||= target` = `_output` so
 *    broadcasts reach the transcript). FROM is the responder, never a reply node.
 *
 * The pid lives only in the wrapped FROM (for HTTP_Filter), not in the node name
 * or the path — so the cwd is the static `/_sse/{reader}`.
 */

import { SseConnectorNode } from './sse-connector-node';
import { FROM, TO } from './message';
import names from './reserved-node-names.json';
import { REPLY_NODES } from './reply-nodes';

export class SseInNode extends SseConnectorNode {
	fill( message ) {
		if ( REPLY_NODES.includes( message[ FROM ] ) ) {
			this.counter += 1;
			// Private reply pivot: `_sse:{pid}/{reply-node}`. The server's HTTP_In
			// stamps the `_http/` boundary prefix on arrival, so we don't hardcode it.
			message[ FROM ] = `${ names.SSE }:${ this.pid() }/${
				message[ FROM ]
			}`;
			message[ TO ] =
				'' === message[ TO ]
					? names.HTTP
					: `${ names.HTTP }/${ message[ TO ] }`;
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}
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
	// accepts_fill is a UI hint (can you wire a connection INTO it); _sse has a fill() but isn't a drag-into target, so false.
	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Bidirectional SSE session boundary (the `_sse` node).',
			accepts_fill: false,
			has_target: true,
			// Inherit the connector's positional args so the base setter still parses them.
			arguments: SseConnectorNode.nodeSchema().arguments,
			commands: [],
		};
	}
}

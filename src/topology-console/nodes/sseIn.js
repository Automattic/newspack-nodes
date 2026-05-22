/**
 * SseIn — the `_sse` console node: the bidirectional SSE session boundary.
 *
 * It is the runtime's SseConnector (opens the EventSource, snoops the
 * `connected` envelope for `pid()`), plus the session routing both legs go
 * through:
 *
 *  - Outgoing — a command routed in via TO=`_sse/…` (so `_router` peeled the
 *    `_sse` head). If FROM is a browser reply node (`_output`/`_metadata`/
 *    `_uptime`) it's wrapped into the private reply pivot
 *    `_http/_sse:{pid}/{from}` and `_http` is prepended to TO, so it routes on to
 *    the HTTP boundary and the server's HTTP_Filter can demux the reply back to
 *    THIS session. (`cd /_http/…` skips `_sse`, so its FROM stays bare and
 *    replies broadcast.)
 *  - Incoming — an SSE reply/broadcast (or the EventSource ingress): FROM is the
 *    responder, never a reply node, so it falls through to the default Node fill
 *    (`TO ||= target` = `_output` so broadcasts reach the transcript), routing
 *    by TO.
 *
 * The pid lives only in the wrapped FROM (for HTTP_Filter), not in the node name
 * or the path — so the cwd is the static `/_sse/{reader}`.
 */

import { SseConnector } from '../../runtime/sse_connector';
import { FROM, TO } from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';

const REPLY_NODES = [ names.OUTPUT, names.METADATA, names.UPTIME ];

export class SseIn extends SseConnector {
	fill( message ) {
		if ( REPLY_NODES.includes( message[ FROM ] ) ) {
			this.counter += 1;
			message[ FROM ] = `${ names.HTTP }/${ names.SSE }:${ this.pid() }/${
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
}

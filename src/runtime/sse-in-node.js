/**
 * SseInNode — the SSE receive-ingress node: the runtime's SseConnector (opens the
 * EventSource, snoops the `connected` envelope for `pid()`), composed UNNAMED by
 * RemoteLink as the per-link inbound stream.
 *
 * Receive-only. Inbound `msg` frames route through the connector's own
 * EventSource listener → `super.fill` (`Node.fill`, route-by-TO) — SseIn adds no
 * `fill()` of its own; it exists only to carry the palette/schema identity. The
 * outgoing reply-FROM wrap (`_sse:{pid}/{node}`) lives in RemoteIpc.
 */

import { SseConnectorNode } from './sse-connector-node';

export class SseInNode extends SseConnectorNode {
	// accepts_fill is a UI hint (can you wire a connection INTO it). SseIn is a
	// pure ingress source, so false.
	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Inbound SSE receive-ingress; composed (unnamed) by RemoteLink as the per-link stream.',
			accepts_fill: false,
			has_target: true,
			// Inherit the connector's positional args so the base setter still parses them.
			arguments: SseConnectorNode.nodeSchema().arguments,
			commands: [],
		};
	}
}

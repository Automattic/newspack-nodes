/**
 * REPLY_NODES — the browser reply/poll nodes whose outgoing command FROM is
 * wrapped into the private `_sse:{pid}/{node}` session pivot so the server's
 * HTTP_Filter can demux their ASYNC reply back to this session's stream.
 *
 * Single source of truth: both the SseIn outgoing leg and the RemoteIpc send
 * path key off this set, so the membership can't drift between them (a missed
 * entry silently drops that node's worker-pivot reply).
 */

import names from './reserved-node-names.json';

export const REPLY_NODES = [
	names.OUTPUT,
	names.METADATA,
	names.UPTIME,
	names.COMPLETION,
	names.HEARTBEAT,
];

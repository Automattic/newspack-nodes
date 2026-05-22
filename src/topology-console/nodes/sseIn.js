/**
 * SseIn — the `_sse` console node. The runtime's generic SseConnector, named
 * for the console graph: it opens an EventSource and fills each parsed
 * positional Message into its sink (`_router`, NOT the Dumper, so replies route
 * by TO to `_output` / `_metadata` / `_uptime`). A thin subclass keeps the
 * published runtime's SseConnector primitive generic (per WIRING-PLAN §1: the
 * client SSE node is `SseIn ← was SseConnector`).
 */

import { SseConnector } from '../../runtime/sse_connector';

export class SseIn extends SseConnector {}

import {
	dumpMetadataPayload,
	parseMetadata,
} from '../../runtime/metadata-node';

/**
 * The page's own live node graph, read off Core's registry with no
 * `dump_metadata` command and no JSON round trip. Composing the wire pair
 * directly — `dumpMetadataPayload()`'s field extraction, then the canvas's
 * `parseMetadata()` transform — gives a local read the same fields, the same
 * defaults and the same hidden backbone a remote reply carries, so one canvas
 * draws either.
 *
 * The graph is the BROWSER's, its reserved scaffolding included, and no worker
 * graph holds that scaffolding. So this is what a local canvas paints from
 * until a reply lands (`useGraphSource`'s `coreFallback`), never a stand-in
 * for a worker's `dump_metadata`.
 *
 * @return {import('../../runtime/metadata-node').MetadataGraph} The live
 *   graph: nodes, edges, the `_output` reply path and the router's profiling
 *   flag.
 */
export function coreToGraph() {
	return parseMetadata( dumpMetadataPayload() );
}

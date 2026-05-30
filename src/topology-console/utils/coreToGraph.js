import {
	dumpMetadataPayload,
	parseMetadata,
} from '../../runtime/metadata-node';

/**
 * The page's own live node graph, read straight off Core.nodes (no
 * dump_metadata command, no JSON round-trip). Reuses the exact dump_metadata
 * field extraction plus the canvas's parseMetadata transform, so a same-realm
 * read is byte-identical to what the topology console sees over the wire.
 *
 * @return {{ nodes: Array, edges: Array }} The live graph as nodes and edges.
 */
export function coreToGraph() {
	return parseMetadata( dumpMetadataPayload() );
}

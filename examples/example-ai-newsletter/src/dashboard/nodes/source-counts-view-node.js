import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

// `source-counts:view` — owns the per-source counts slice ({ sources:{name:count} }).
// React reads it via useNodeState('source-counts:view','view') in <SourceCounts/>.
export class SourceCountsViewNode extends SliceViewNode {
	emptySlice() {
		return { sources: {} };
	}
}

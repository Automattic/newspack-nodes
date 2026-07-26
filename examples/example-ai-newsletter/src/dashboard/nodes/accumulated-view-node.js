import { SliceViewNode } from '@newspack-nodes/shared/nodes/slice-view-node';

/**
 * `accumulated:view` — owns the accumulated-count slice ({ accumulated:N }). React
 * reads it via useNodeState('accumulated:view','view') in <AccumulatedCard/>.
 */
export class AccumulatedViewNode extends SliceViewNode {
	emptySlice() {
		return { accumulated: 0 };
	}
}

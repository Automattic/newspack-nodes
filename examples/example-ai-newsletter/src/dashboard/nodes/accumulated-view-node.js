import { SliceViewNode } from '@newspack-nodes/shared/nodes/SliceViewNode';

// `accumulated:view` — owns the accumulated-count slice ({ accumulated:N }). React
// reads it via useNodeState('accumulated:view','view') in <AccumulatedCard/>.
export class AccumulatedViewNode extends SliceViewNode {
	emptySlice() {
		return { accumulated: 0 };
	}
}

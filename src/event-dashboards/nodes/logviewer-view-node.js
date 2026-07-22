import { PartitionViewerViewNode } from './partition-viewer-view-node';

/**
 * `logviewer:view` — the Log Viewer's raw-line ring.
 *
 * The same O(1) newest-first ring + control/reply model as the Partition Viewer's
 * view, over plain log FILE lines instead of packed partition envelopes (a raw
 * line arrives as the message VALUE with no KEY prefix and a single source, so it
 * shapes to partition 0 — the Log Viewer renders no partition column). Kept a
 * distinct class so the two dashboards' view models can diverge without touching
 * the other, while sharing the ring implementation.
 */
export class LogViewerViewNode extends PartitionViewerViewNode {
	static nodeSchema() {
		return {
			...super.nodeSchema(),
			description: 'Log Viewer render-model sink (raw log-file lines).',
		};
	}
}

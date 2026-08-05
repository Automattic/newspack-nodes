import { PartitionViewerViewNode } from './partition-viewer-view-node';

/**
 * `logviewer:view` — the Log Viewer's raw-line ring.
 *
 * The same O(1) newest-first ring + control model as the Partition Viewer's
 * view, over plain log FILE lines instead of packed partition envelopes (a raw
 * line arrives as the message VALUE with no KEY prefix and a single source, so it
 * shapes to partition 0 — the Log Viewer renders no partition column). Kept a
 * distinct class so the two dashboards' view models can diverge without touching
 * the other, while sharing the ring implementation.
 */
export class LogViewerViewNode extends PartitionViewerViewNode {
	/**
	 * Node metadata behind `help <Type>` and the console's node palette.
	 * Inherits the shared log-stream view schema — Hidden category, no target,
	 * no arguments — and restates only the description in the Log Viewer's
	 * terms, so the palette entry names raw log lines rather than partitions.
	 *
	 * @return {Object} Schema: category, description, has_target, arguments,
	 *                  commands.
	 */
	static nodeSchema() {
		return {
			...super.nodeSchema(),
			description: 'Log Viewer render-model sink (raw log-file lines).',
		};
	}
}

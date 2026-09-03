import { PartitionViewerViewNode } from './partition-viewer-view-node';

/**
 * `logviewer:view` — the Log Viewer's raw-line ring.
 *
 * Extends the Partition Viewer's view for the two things `LogStreamViewNode`
 * alone would not give it: `shapeRow()`, which turns an SSE envelope into a
 * row carrying `content` and the debug trio, and the `selected` model field
 * the source picker binds to — `LogStreamViewNode`'s own `select` verb clears
 * the ring and the seek tracker but records no name. The ring, the paused belt
 * and the seek tracking come from that shared base beneath both dashboards.
 *
 * The rows are plain log-FILE lines rather than packed partition envelopes:
 * the `Tail` behind `/log/stream` stamps the line as VALUE, leaves KEY empty
 * and stamps FROM with the registry source name, so `content` is the bare
 * line. The inherited `partition` column therefore reads the number out of a
 * `<base>.pN` topology source and falls to a first-seen index for a plain file
 * — a column the Log Viewer never renders, drawing one cell per row.
 *
 * The inherited `logs` catalog rides along unused. `useLogViewerGraph` polls
 * `taillog sources` and hands the picker those rows itself, so nothing ever
 * sends the `logs` control and the published `logs` array stays empty.
 *
 * A separate class keeps the two dashboards' view models free to diverge
 * without an edit to one touching the other.
 */
export class LogViewerViewNode extends PartitionViewerViewNode {
	/**
	 * Node metadata behind `help <Type>` and the console's node palette.
	 * Keeps the inherited Hidden category, no target and no arguments, and
	 * overrides the description alone — without that override the palette
	 * would label this node the Partition Viewer's sink.
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

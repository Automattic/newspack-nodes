// Register the dashboard-specific node classes into the interpreter's
// includeNodes map so they're createable via interpreter.makeNode — mirrors
// PHP's per-plugin namespace registration. Imported (for its side effect) by
// the dashboard hooks and the bundle entry, so registration runs before any
// graph build.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { RawLogsViewNode } from './raw-logs-view-node';
import { TopicProbeViewNode } from './topic-probe-view-node';
import { TopologyManagerViewNode } from './topology-manager-view-node';
import { WorkerStatusTransformNode } from './worker-status-transform-node';
import { WorkerStatusViewNode } from './worker-status-view-node';

CommandInterpreterNode.registerNodeClasses( {
	RawLogsView: RawLogsViewNode,
	TopicProbeView: TopicProbeViewNode,
	TopologyManagerView: TopologyManagerViewNode,
	WorkerStatusTransform: WorkerStatusTransformNode,
	WorkerStatusView: WorkerStatusViewNode,
} );

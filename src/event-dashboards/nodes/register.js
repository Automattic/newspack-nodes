// Register the dashboard-specific node classes into the interpreter's
// includeNodes map so they're createable via interpreter.makeNode — mirrors
// PHP's per-plugin namespace registration. Imported (for its side effect) by
// the dashboard hooks and the bundle entry, so registration runs before any
// graph build.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { RawLogsViewNode } from './rawLogsView';
import { TopologyManagerViewNode } from './topologyManagerView';
import { WorkerStatusTransformNode } from './workerStatusTransform';
import { WorkerStatusViewNode } from './workerStatusView';

CommandInterpreterNode.registerNodeClasses( {
	RawLogsView: RawLogsViewNode,
	TopologyManagerView: TopologyManagerViewNode,
	WorkerStatusTransform: WorkerStatusTransformNode,
	WorkerStatusView: WorkerStatusViewNode,
} );

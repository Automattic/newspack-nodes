// Register dashboard node classes so interpreter.makeNode can create them.
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

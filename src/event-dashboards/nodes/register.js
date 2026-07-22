// Register dashboard node classes so interpreter.makeNode can create them.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { JobstatsViewNode } from './jobstats-view-node';
import { PartitionViewerViewNode } from './partition-viewer-view-node';
import { LogViewerViewNode } from './logviewer-view-node';
import { SettingsAuditViewNode } from './settings-audit-view-node';
import { TopicProbeViewNode } from './topic-probe-view-node';
import { TopologyManagerViewNode } from './topology-manager-view-node';
import { WorkerStatusTransformNode } from './worker-status-transform-node';
import { WorkerStatusViewNode } from './worker-status-view-node';

CommandInterpreterNode.registerNodeClasses( {
	JobstatsView: JobstatsViewNode,
	PartitionViewerView: PartitionViewerViewNode,
	LogViewerView: LogViewerViewNode,
	SettingsAuditView: SettingsAuditViewNode,
	TopicProbeView: TopicProbeViewNode,
	TopologyManagerView: TopologyManagerViewNode,
	WorkerStatusTransform: WorkerStatusTransformNode,
	WorkerStatusView: WorkerStatusViewNode,
} );

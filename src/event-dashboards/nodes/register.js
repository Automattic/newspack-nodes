// Register dashboard node classes so interpreter.makeNode can create them.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';
import { JobstatsViewNode } from './jobstats-view-node';
import { TopicProbeViewNode } from './topic-probe-view-node';
import { PartitionViewerViewNode } from './partition-viewer-view-node';
import { LogViewerViewNode } from './logviewer-view-node';
import { SettingsAuditViewNode } from './settings-audit-view-node';
import { WorkerStatusTransformNode } from './worker-status-transform-node';
import { WorkerStatusViewNode } from './worker-status-view-node';

// Views that own more than a slice — a ring buffer, a timer, their own fill().
const OWN_CLASSES = {
	JobstatsView: JobstatsViewNode,
	PartitionViewerView: PartitionViewerViewNode,
	LogViewerView: LogViewerViewNode,
	SettingsAuditView: SettingsAuditViewNode,
	TopicProbeView: TopicProbeViewNode,
	WorkerStatusTransform: WorkerStatusTransformNode,
	WorkerStatusView: WorkerStatusViewNode,
};
CommandInterpreterNode.registerNodeClasses( OWN_CLASSES );

/**
 * Every view this dashboard set owns, by name.
 *
 * @type {Object<string,any>} Registration is for TSL and the
 * palette; a hook builds its own graph by handing the CLASS to `makeNode`,
 * because the name map is a per-bundle static and a hub tab runs against
 * whichever bundle's interpreter it was handed.
 */
export const views = {
	...OWN_CLASSES,
	...registerSliceViews( {
		// The Topology Manager list; an activate is answered on its own node.
		TopologyManagerView: {
			description:
				'Topology Manager list-model sink (the React view node).',
			empty: {
				topologies: [],
				userDir: null,
				error: null,
				loading: true,
			},
			parse: ( body ) =>
				body && 'object' === typeof body
					? {
							topologies: body.topologies || [],
							userDir: body.user_dir ?? null,
							error: null,
							loading: false,
					  }
					: null,
		},
	} ),
};

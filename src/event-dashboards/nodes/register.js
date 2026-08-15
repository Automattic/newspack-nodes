// Register dashboard node classes so interpreter.makeNode can create them.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';
import { JobstatsViewNode } from './jobstats-view-node';
import { PartitionViewerViewNode } from './partition-viewer-view-node';
import { LogViewerViewNode } from './logviewer-view-node';
import { SettingsAuditViewNode } from './settings-audit-view-node';
import { TopicProbeViewNode } from './topic-probe-view-node';
import { WorkerStatusTransformNode } from './worker-status-transform-node';
import { WorkerStatusViewNode } from './worker-status-view-node';

// Views that own more than a slice — a ring buffer, a timer, their own fill().
CommandInterpreterNode.registerNodeClasses( {
	JobstatsView: JobstatsViewNode,
	PartitionViewerView: PartitionViewerViewNode,
	LogViewerView: LogViewerViewNode,
	SettingsAuditView: SettingsAuditViewNode,
	TopicProbeView: TopicProbeViewNode,
	WorkerStatusTransform: WorkerStatusTransformNode,
	WorkerStatusView: WorkerStatusViewNode,
} );

/** The classes, for the tests that instantiate them. @testonly */
export const views = registerSliceViews( {
	// A catalog whose reply IS a list: `taillog sources`, `list_logs`.
	CatalogListView: {
		empty: { items: [], error: null },
		parse: ( body ) =>
			Array.isArray( body ) ? { items: body, error: null } : null,
	},

	// The Topology Manager list; an activate is answered on its own node.
	TopologyManagerView: {
		description: 'Topology Manager list-model sink (the React view node).',
		empty: { topologies: [], userDir: null, error: null, loading: true },
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
} );

/**
 * The Event Dashboards bundle's node classes, bound to their `make_node` names.
 *
 * A name and its class are declared together here: importing this file enters
 * the names in the browser interpreter's class table, and importing `views`
 * hands a hook the class itself.
 */

import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { registerSliceViews } from '@newspack-nodes/shared/nodes/slice-view-node';
import { JobstatsViewNode } from './jobstats-view-node';
import { TopicProbeViewNode } from './topic-probe-view-node';
import { PartitionViewerViewNode } from './partition-viewer-view-node';
import { LogViewerViewNode } from './logviewer-view-node';
import { SettingsAuditViewNode } from './settings-audit-view-node';
import { WorkerStatusTransformNode } from './worker-status-transform-node';
import { WorkerStatusViewNode } from './worker-status-view-node';

/**
 * The classes written out rather than declared through `sliceView()`: views
 * that own more than a slice — a ring buffer, a timer, their own `fill()` —
 * plus the Worker Status transform, which sits on the graph edge ahead of its
 * view rather than owning a slice at all.
 */
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
 * Every node class this dashboard set owns, by name.
 *
 * A name serves the text path — TSL, the console palette, `make_node` typed
 * into the REPL. A hook builds its graph by handing `makeNode` the CLASS out of
 * this map instead, because the name table is a per-bundle static and the
 * devtools hub mounts these tabs against whichever bundle's interpreter it was
 * handed ([ADR-16](../../../docs/architecture-decisions.md)).
 *
 * The widening below is load-bearing rather than a restatement of inference.
 * Spreading `registerSliceViews()`'s return drops its index signature, so
 * without it every slice-view key reads as absent and `useTopologyManager`
 * fails the type check on `views.TopologyManagerView`.
 *
 * @type {Object<string,any>}
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

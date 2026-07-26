/**
 * Register the dashboard-specific node classes into the interpreter's
 * includeNodes map so they're createable via interpreter.makeNode — mirrors
 * PHP's per-plugin namespace registration. Timer/Tee/Fetcher/Tap/HttpOut are
 * runtime nodes (already registered); only the three thin slice view nodes are
 * application-specific. Imported (for its side effect) by the dashboard hook and
 * the bundle entry, so registration runs before the build.
 */
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import { SourceCountsViewNode } from './source-counts-view-node';
import { TopTableViewNode } from './top-table-view-node';
import { AccumulatedViewNode } from './accumulated-view-node';

CommandInterpreterNode.registerNodeClasses( {
	SourceCountsView: SourceCountsViewNode,
	TopTableView: TopTableViewNode,
	AccumulatedView: AccumulatedViewNode,
} );

/**
 * Register this dashboard's three view classes on the interpreter's node table.
 *
 * `CommandInterpreterNode.includeNodes` maps a make_node NAME to its class, and
 * a class missing from it cannot be built from TSL, from the console palette, or
 * by `makeNode( 'SourceCountsView', … )`. Registration runs at import time, so
 * `usePublisherInsightsGraph` imports this module for the side effect alone,
 * before `addSliceFetcher` resolves each slice's `viewClass` name.
 *
 * The three views are all this dashboard adds. Timer, Tee and Fetcher, the rest
 * of the poll graph, are runtime classes the table already carries.
 *
 * That table is a per-bundle static (ADR-16), so these names resolve only
 * through an interpreter this bundle mounted. The Publisher Insights page mounts
 * its own; a graph built through another bundle's interpreter has to be handed
 * the class itself.
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

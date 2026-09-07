/**
 * Register this dashboard's three view classes on the interpreter's node table.
 *
 * `CommandInterpreterNode.includeNodes` maps a make_node NAME to its class, so
 * registering here is what lets a TSL line, or a `make_node SourceCountsView`
 * typed into the console REPL, build one of these views. The console PALETTE is
 * the one text path they never reach: `SliceViewNode.nodeSchema()` declares
 * `category: 'Hidden'`, and `useJsCatalog` offers only a class whose category
 * is neither Hidden nor empty.
 *
 * Registration runs at import time, and `usePublisherInsightsGraph` imports
 * this module for that side effect alone: it hands `addSliceFetcher` each view
 * CLASS, not the name registered here.
 *
 * The three views are all this dashboard adds. Timer, Tee and Fetcher, the
 * other classes the poll graph names, already ship in the table.
 *
 * That table is a per-bundle static (ADR-16), so these names resolve only
 * through an interpreter this bundle mounted. The Publisher Insights page
 * mounts its own; a graph built through another bundle's interpreter has to be
 * handed the class itself, which is why the hook hands one.
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

// Register this dashboard's per-slice view classes into the interpreter's
// includeNodes map so they're createable via interpreter.makeNode — mirrors
// PHP's per-plugin namespace registration. Imported (for its side effect) by
// the hook and the bundle entry, so registration runs before any graph build.
//
// De-god split: the single AggregatorView god node (fed by one `status` verb)
// is gone, replaced by two per-slice views — each on its own slice verb with
// its own inspectable reply path.
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import { AggregatorSummaryViewNode } from './aggregator-summary-view-node';
import { AggregatorServersViewNode } from './aggregator-servers-view-node';

CommandInterpreterNode.registerNodeClasses( {
	AggregatorSummaryView: AggregatorSummaryViewNode,
	AggregatorServersView: AggregatorServersViewNode,
} );

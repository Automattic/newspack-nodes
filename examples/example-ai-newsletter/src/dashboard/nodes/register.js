// Register the dashboard-specific node classes into the interpreter's
// includeNodes map so they're createable via interpreter.makeNode — mirrors
// PHP's per-plugin namespace registration. Imported (for its side effect) by
// the dashboard hook and the bundle entry, so registration runs before the build.
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import { InsightsViewNode } from './insightsView';

CommandInterpreterNode.registerNodeClasses( {
	InsightsView: InsightsViewNode,
} );

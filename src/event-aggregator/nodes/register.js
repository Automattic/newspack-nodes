// Register this dashboard's node class into the interpreter's includeNodes map
// so it's createable via interpreter.makeNode — mirrors PHP's per-plugin
// namespace registration. Imported (for its side effect) by the hook and the
// bundle entry, so registration runs before any graph build.
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import { AggregatorViewNode } from './aggregator-view-node';

CommandInterpreterNode.registerNodeClasses( {
	AggregatorView: AggregatorViewNode,
} );

/**
 * Registration test — importing the dashboard's node module registers its
 * per-slice view classes into the interpreter's includeNodes map so they're
 * createable via interpreter.makeNode (mirrors PHP's per-plugin namespace
 * registration): AggregatorSummaryView + AggregatorServersView, not one god
 * node.
 */
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import '../register';

it( 'registers its per-slice view classes for make_node', () => {
	expect(
		CommandInterpreterNode.includeNodes.AggregatorSummaryView
	).toBeDefined();
	expect(
		CommandInterpreterNode.includeNodes.AggregatorServersView
	).toBeDefined();
} );

it( 'no longer registers the retired god / fleet-correlation view nodes', () => {
	expect(
		CommandInterpreterNode.includeNodes.AggregatorView
	).toBeUndefined();
	// The probe is a node per spoke; nothing files roll-ups by op-id.
	expect(
		CommandInterpreterNode.includeNodes.AggregatorFleetView
	).toBeUndefined();
} );

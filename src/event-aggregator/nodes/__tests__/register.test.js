/**
 * Registration test — importing the dashboard's node module registers its
 * class(es) into the interpreter's includeNodes map so they're createable via
 * interpreter.makeNode (mirrors PHP's per-plugin namespace registration).
 */
import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import '../register';

it( 'registers its dashboard node classes for make_node', () => {
	expect( CommandInterpreterNode.includeNodes.AggregatorView ).toBeDefined();
} );

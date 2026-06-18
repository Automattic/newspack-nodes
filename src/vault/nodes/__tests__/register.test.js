/**
 * Registration test — importing the vault tab's node module registers its
 * class(es) into the interpreter's includeNodes map so they're createable via
 * interpreter.makeNode (mirrors PHP's per-plugin namespace registration).
 */
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';
import '../register';

it( 'registers its node classes for make_node', () => {
	expect( CommandInterpreterNode.includeNodes.VaultView ).toBeDefined();
} );

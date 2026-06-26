/**
 * Registration test — importing the vault tab's node module registers its
 * per-concern view classes into the interpreter's includeNodes map so they're
 * createable via interpreter.makeNode (mirrors PHP's per-plugin namespace
 * registration). The de-god split replaced the single `VaultView` god view with
 * a credential-LIST view and a TEST-result view.
 */
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';
import { VaultListViewNode } from '../vault-list-view-node';
import { VaultTestViewNode } from '../vault-test-view-node';
import '../register';

it( 'registers the credential-list view for make_node', () => {
	expect( CommandInterpreterNode.includeNodes.VaultListView ).toBe(
		VaultListViewNode
	);
} );

it( 'registers the test-result view for make_node', () => {
	expect( CommandInterpreterNode.includeNodes.VaultTestView ).toBe(
		VaultTestViewNode
	);
} );

it( 'no longer registers the old god view', () => {
	expect( CommandInterpreterNode.includeNodes.VaultView ).toBeUndefined();
} );

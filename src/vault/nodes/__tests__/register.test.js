/**
 * Registration test — importing the vault tab's node module registers its
 * per-concern view classes into the interpreter's includeNodes map so they're
 * createable via interpreter.makeNode (mirrors PHP's per-plugin namespace
 * registration). The de-god split replaced the single `VaultView` god view with
 * a credential-LIST view and a TEST-result view.
 */
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';
import { views } from '../register';

it( 'registers the credential-list view for make_node', () => {
	expect( CommandInterpreterNode.includeNodes.VaultListView ).toBe(
		views.VaultListView
	);
} );

it( 'no longer registers the god view or the probe-correlation view', () => {
	expect( CommandInterpreterNode.includeNodes.VaultView ).toBeUndefined();
	// The probe is its own Request node now; nothing files results by op-id.
	expect( CommandInterpreterNode.includeNodes.VaultTestView ).toBeUndefined();
} );

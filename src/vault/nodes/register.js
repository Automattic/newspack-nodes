// Register the vault view classes so interpreter.makeNode can create them.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { VaultListViewNode } from './vault-list-view-node';
import { VaultTestViewNode } from './vault-test-view-node';

CommandInterpreterNode.registerNodeClasses( {
	VaultListView: VaultListViewNode,
	VaultTestView: VaultTestViewNode,
} );

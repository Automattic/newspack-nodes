// Register the vault tab's per-concern view classes into the interpreter's
// includeNodes map so they're createable via interpreter.makeNode — mirrors
// PHP's per-plugin namespace registration. Imported (for its side effect) by the
// hook and the bundle entry, so registration runs before any graph build.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { VaultListViewNode } from './vault-list-view-node';
import { VaultTestViewNode } from './vault-test-view-node';

CommandInterpreterNode.registerNodeClasses( {
	VaultListView: VaultListViewNode,
	VaultTestView: VaultTestViewNode,
} );

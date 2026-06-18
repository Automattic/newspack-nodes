// Register the vault tab's node class into the interpreter's includeNodes map
// so it's createable via interpreter.makeNode — mirrors PHP's per-plugin
// namespace registration. Imported (for its side effect) by the hook and the
// bundle entry, so registration runs before any graph build.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { VaultViewNode } from './vault-view-node';

CommandInterpreterNode.registerNodeClasses( {
	VaultView: VaultViewNode,
} );

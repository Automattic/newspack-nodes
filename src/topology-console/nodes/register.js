// Register the console's view classes so interpreter.makeNode can create them.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { ClassCatalogViewNode } from './class-catalog-view-node';
import { TopologyListViewNode } from './topology-list-view-node';
import { VaultCatalogViewNode } from './vault-catalog-view-node';

CommandInterpreterNode.registerNodeClasses( {
	ClassCatalogView: ClassCatalogViewNode,
	TopologyListView: TopologyListViewNode,
	VaultCatalogView: VaultCatalogViewNode,
} );

// Register the sessions view class so interpreter.makeNode can create it.
import { CommandInterpreterNode } from '../../runtime/command-interpreter-node';
import { SessionListViewNode } from './session-list-view-node';

CommandInterpreterNode.registerNodeClasses( {
	SessionListView: SessionListViewNode,
} );

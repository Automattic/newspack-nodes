import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';
import '../register';

describe( 'event-dashboards node registration', () => {
	it( 'registers the dashboard node classes for make_node', () => {
		for ( const t of [
			'LogViewerView',
			'WorkerStatusTransform',
			'WorkerStatusView',
			'JobstatsView',
			'SettingsAuditView',
		] ) {
			expect( CommandInterpreterNode.includeNodes[ t ] ).toBeDefined();
		}
		expect(
			CommandInterpreterNode.includeNodes.PartitionViewerView
		).toBeUndefined();
	} );
} );

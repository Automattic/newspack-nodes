import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import '../register';

describe( 'dashboard node registration', () => {
	it( 'registers InsightsView for make_node', () => {
		expect(
			CommandInterpreterNode.includeNodes.InsightsView
		).toBeDefined();
	} );
} );

import { CommandInterpreterNode } from '@newspack-nodes/runtime';
import '../register';
import { SourceCountsViewNode } from '../source-counts-view-node';
import { TopTableViewNode } from '../top-table-view-node';
import { AccumulatedViewNode } from '../accumulated-view-node';

describe( 'dashboard node registration', () => {
	// Each shell name must map to its OWN class — a copy-paste swap (e.g. pointing
	// `TopTableView` at SourceCountsViewNode) must fail here, not just `.toBeDefined()`.
	it.each( [
		[ 'SourceCountsView', SourceCountsViewNode, { sources: {} } ],
		[ 'TopTableView', TopTableViewNode, { top: [] } ],
		[ 'AccumulatedView', AccumulatedViewNode, { accumulated: 0 } ],
	] )(
		'%s registers its exact class and constructs with the right empty slice',
		( shellName, klass, emptySlice ) => {
			const registered = CommandInterpreterNode.includeNodes[ shellName ];
			expect( registered ).toBe( klass );
			const node = new registered();
			expect( node ).toBeInstanceOf( klass );
			expect( node.emptySlice() ).toEqual( emptySlice );
		}
	);

	it( 'no longer registers the retired god view node', () => {
		expect(
			CommandInterpreterNode.includeNodes.InsightsView
		).toBeUndefined();
	} );
} );

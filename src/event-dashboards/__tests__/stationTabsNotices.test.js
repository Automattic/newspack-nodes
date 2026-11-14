/* eslint-env jest */
/**
 * The Overview tab's notices: what the fleet board could not read, each
 * said in its own sentence, and the connection banner's state.
 */

const mockBoard = {};
let mockConnected = true;
jest.mock( '../hooks/useTopologyManager', () => ( {
	useTopologyBoard: () => mockBoard,
	useConnected: () => mockConnected,
} ) );
jest.mock( '../../station/StationLayout', () => ( { children } ) => (
	<div>{ children }</div>
) );
jest.mock(
	'@newspack-nodes/shared/components/UnparseableLinesNotice',
	() => () => null
);

import { render, screen } from '@testing-library/react';
import { OverviewTab } from '../stationTabs';

beforeEach( () => {
	for ( const key of Object.keys( mockBoard ) ) {
		delete mockBoard[ key ];
	}
	mockConnected = true;
} );

it( 'names each topology the board could not read, with its reason', () => {
	mockBoard.unreadable = { 'tui-7712': 'bad token at line 9' };
	render( <OverviewTab /> );
	expect(
		screen.getByText(
			'Topology tui-7712 will not read, so this board leaves it out: bad token at line 9'
		)
	).toBeTruthy();
} );

it( 'names each log producer the catalog refused, with its reason', () => {
	mockBoard.refusedProducers = { 'logs/kiwi-7713': 'outside the base' };
	render( <OverviewTab /> );
	expect(
		screen.getByText(
			'The log catalog leaves out logs/kiwi-7713, and the log sweep refuses to run: outside the base'
		)
	).toBeTruthy();
} );

it( 'shows the disconnection banner only while disconnected', () => {
	mockConnected = false;
	const { unmount } = render( <OverviewTab /> );
	expect( screen.queryByText( /Disconnected/ ) ).toBeTruthy();
	unmount();
	mockConnected = true;
	render( <OverviewTab /> );
	expect( screen.queryByText( /Disconnected/ ) ).toBeNull();
} );

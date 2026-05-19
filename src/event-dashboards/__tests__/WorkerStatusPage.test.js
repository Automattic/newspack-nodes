/**
 * WorkerStatusPage — fixed-position wrapper around WorkerStatus.
 * WorkerStatus itself is very large; we mock it here to keep the test
 * focused on the wrapper's layout contract.
 */

import { render } from '@testing-library/react';
import WorkerStatusPage from '../WorkerStatusPage';

jest.mock( '../WorkerStatus', () => ( props ) => (
	<div data-testid="worker-status" data-props={ JSON.stringify( props ) } />
) );
jest.mock( '../../shared/hooks/useAdminMenuWidth', () => ( {
	__esModule: true,
	default: () => 200,
} ) );

describe( 'WorkerStatusPage', () => {
	it( 'renders WorkerStatus with refreshMs=2000 and fullPage=true', () => {
		const { getByTestId } = render( <WorkerStatusPage /> );
		const status = getByTestId( 'worker-status' );
		const props = JSON.parse( status.dataset.props );
		expect( props ).toEqual( { refreshMs: 2000, fullPage: true } );
	} );

	it( 'wraps content in a fixed container offset by menu width', () => {
		const { container } = render( <WorkerStatusPage /> );
		const wrapper = container.firstChild;
		expect( wrapper.style.position ).toBe( 'fixed' );
		expect( wrapper.style.left ).toBe( '200px' );
		expect( wrapper.style.top ).toBe( '32px' );
	} );
} );

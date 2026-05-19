/**
 * RawLogsPage — fixed-position wrapper around RawLogs with admin-menu-
 * width left offset. RawLogs itself is large and exercised separately;
 * we mock it here to keep the test focused on the wrapper.
 */

import { render } from '@testing-library/react';
import RawLogsPage from '../RawLogsPage';

jest.mock( '../RawLogs', () => () => <div data-testid="raw-logs" /> );
jest.mock( '../../shared/hooks/useAdminMenuWidth', () => ( {
	__esModule: true,
	default: () => 160,
} ) );

describe( 'RawLogsPage', () => {
	it( 'renders the RawLogs panel inside a fixed wrapper offset by menu width', () => {
		const { getByTestId, container } = render( <RawLogsPage /> );
		// jest-dom isn't installed in this repo; fall back to bare DOM
		// assertions, which is the same approach the existing tests use.
		expect( getByTestId( 'raw-logs' ) ).not.toBeNull();
		const wrapper = container.firstChild;
		expect( wrapper.style.position ).toBe( 'fixed' );
		expect( wrapper.style.top ).toBe( '32px' );
		expect( wrapper.style.left ).toBe( '160px' );
	} );
} );

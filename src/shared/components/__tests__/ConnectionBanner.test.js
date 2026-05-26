/**
 * ConnectionBanner tests — the shared connection/reconnect banner.
 *
 * Follows the same harness as event-dashboards/WorkerStatus.test.js: the
 * testing-library `render`, asserting against the returned `container`. The
 * .scss import is handled by jest.config.js's moduleNameMapper
 * (`\\.(css|scss)$` to jest.style-mock.js), like every other styled component.
 */

import { render } from '@testing-library/react';
import ConnectionBanner from '../ConnectionBanner';

describe( 'ConnectionBanner', () => {
	it( 'renders the default banner text when connectionError is true', () => {
		const { container } = render(
			<ConnectionBanner connectionError={ true } />
		);
		const banner = container.querySelector(
			'.newspack-nodes-connection-banner'
		);
		expect( banner ).not.toBeNull();
		expect( banner.textContent ).toBe( 'Connection lost. Reconnecting…' );
	} );

	it( 'renders nothing when connectionError is false', () => {
		const { container } = render(
			<ConnectionBanner connectionError={ false } />
		);
		expect(
			container.querySelector( '.newspack-nodes-connection-banner' )
		).toBeNull();
		expect( container.childNodes.length ).toBe( 0 );
	} );

	it( 'renders the override message instead of the default', () => {
		const { container } = render(
			<ConnectionBanner
				connectionError={ true }
				message="Server disconnected. Reconnecting..."
			/>
		);
		const banner = container.querySelector(
			'.newspack-nodes-connection-banner'
		);
		expect( banner.textContent ).toBe(
			'Server disconnected. Reconnecting...'
		);
		expect( banner.textContent ).not.toBe(
			'Connection lost. Reconnecting…'
		);
	} );
} );

/**
 * StalenessIndicator tests — the ONE shared decision every streaming dashboard
 * makes for its "Ns ago" chrome: while PAUSED the stream is intentionally
 * closed, so show a steady "Paused" label instead of a clock that would climb
 * forever; otherwise "Ns ago" since the last frame (amber past the threshold),
 * or nothing when no frame has ever arrived.
 *
 * Same harness as ConnectionBanner.test.js: testing-library `render` asserting
 * against `container`; the .scss import is style-mocked by jest.config.js.
 */

import fs from 'fs';
import path from 'path';
import { render } from '@testing-library/react';
import StalenessIndicator from '../StalenessIndicator';

describe( 'StalenessIndicator', () => {
	it( 'shows a steady "Paused" label while paused — never the climbing clock', () => {
		// A live-looking staleSec is present; paused MUST still win (precedence).
		const { container } = render(
			<StalenessIndicator paused={ true } staleSec={ 42 } />
		);
		const el = container.querySelector( '.newspack-nodes-staleness' );
		expect( el ).not.toBeNull();
		expect( el.textContent ).toBe( 'Paused' );
		expect( el.className ).not.toContain(
			'newspack-nodes-staleness--warn'
		);
	} );

	it( 'counts up "Ns ago" (muted) when live and recently seen', () => {
		const { container } = render(
			<StalenessIndicator paused={ false } staleSec={ 3 } />
		);
		const el = container.querySelector( '.newspack-nodes-staleness' );
		expect( el.textContent ).toBe( '3s ago' );
		expect( el.className ).not.toContain(
			'newspack-nodes-staleness--warn'
		);
	} );

	it( 'turns amber (--warn) past the 10s threshold', () => {
		const { container } = render(
			<StalenessIndicator paused={ false } staleSec={ 15 } />
		);
		const el = container.querySelector( '.newspack-nodes-staleness--warn' );
		expect( el ).not.toBeNull();
		expect( el.textContent ).toBe( '15s ago' );
	} );

	it( 'renders nothing when no frame has ever arrived (staleSec null)', () => {
		const { container } = render(
			<StalenessIndicator paused={ false } staleSec={ null } />
		);
		expect( container.childNodes.length ).toBe( 0 );
	} );

	it( 'colours off the --ink-3 / --brass tokens, not fixed hexes', () => {
		const scss = fs.readFileSync(
			path.join( __dirname, '..', 'StalenessIndicator.scss' ),
			'utf8'
		);
		expect( scss ).toMatch( /var\(\s*--ink-3/ );
		expect( scss ).toMatch( /var\(\s*--brass/ );
	} );
} );

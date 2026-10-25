/**
 * Tests for DashboardShell — the fixed full-viewport chrome every standalone
 * dashboard page shares.
 *
 * The debug overlay is mocked so the storage key each page hands the shell is
 * observable in the rendered text; a shared key would silently merge two
 * dashboards' persisted panel layouts.
 */

jest.mock( '@newspack-nodes/debug-overlay', () => ( {
	__esModule: true,
	default: ( { storageKey } ) => `OVERLAY[${ storageKey }]`,
} ) );

import { createElement } from 'react';
import { render } from '@testing-library/react';
import DashboardShell from '../DashboardShell';

describe( 'DashboardShell', () => {
	it( 'wraps its children in one skinned provider over a fixed viewport box', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'newspack-nodes:debug:probe-shell',
				overflowY: 'scroll',
				children: () => 'CHILD_MARKER',
			} )
		);

		const provider = container.firstElementChild;
		expect( provider.className ).toBe(
			'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( provider.style.display ).toBe( 'contents' );

		const box = provider.firstElementChild;
		expect( box.style.position ).toBe( 'fixed' );
		expect( box.style.top ).toBe( '32px' );
		expect( box.style.overflowX ).toBe( 'hidden' );
		expect( container.textContent ).toContain( 'CHILD_MARKER' );
		unmount();
	} );

	it( 'paints an opaque backdrop, so nothing behind the box shows through', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'newspack-nodes:debug:probe-shell',
				overflowY: 'scroll',
				children: () => null,
			} )
		);

		// The box is positioned, not flowed, so an admin notice WordPress
		// relocates above it keeps its own place in the document and shows
		// through a transparent backdrop. The substrate's shared page-surface
		// class is what paints it; appearance stays out of the inline style.
		expect( container.firstElementChild.firstElementChild.className ).toBe(
			'newspack-nodes-page-surface'
		);
		unmount();
	} );

	it( 'heads every dashboard with one wordmark naming its own surface', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'newspack-nodes:debug:probe-shell',
				overflowY: 'scroll',
				subtitle: 'Probe Surface',
				children: () => null,
			} )
		);

		// One header, the substrate wordmark, and a subtitle naming THIS
		// dashboard rather than the station the shared component came from.
		expect( container.querySelectorAll( '.topology-header' ) ).toHaveLength(
			1
		);
		expect(
			container.querySelector( '.topology-brand' ).textContent
		).toContain( 'NEWSPACK' );
		const subtitle = container.querySelector( '.topology-subtitle' );
		expect( subtitle.textContent ).toContain( 'Probe Surface' );
		unmount();
	} );

	it( 'lays the box out as a column, so the header takes no page height', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'newspack-nodes:debug:probe-shell',
				overflowY: 'scroll',
				subtitle: 'Probe Surface',
				children: () => null,
			} )
		);

		// A block box would leave the dashboard root's `height: 100%` resolving
		// against the WHOLE box while the header pushed it down 64px — clipped
		// under overflow hidden, a permanent scrollbar under auto. The station
		// box this copies is a flex column for the same reason.
		const box = container.firstElementChild.firstElementChild;
		expect( box.style.display ).toBe( 'flex' );
		expect( box.style.flexDirection ).toBe( 'column' );
		unmount();
	} );

	it( 'scrolls on the axis the page asks for', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'newspack-nodes:debug:probe-shell',
				overflowY: 'scroll',
				children: () => null,
			} )
		);

		expect(
			container.querySelector( '.newspack-nodes-page-content' ).style
				.overflowY
		).toBe( 'scroll' );
		unmount();
	} );

	// The reader's page is the area under the header — what scrolls, and what
	// the brief answers for — so the target and the ring go there.
	it( 'carries the page ask target on what scrolls, when a page has one', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'k',
				overflowY: 'scroll',
				askDescriptor: 'overview:site',
				children: () => null,
			} )
		);

		const content = container.querySelector(
			'.newspack-nodes-page-content'
		);
		expect( content.getAttribute( 'data-ask' ) ).toBe( 'overview:site' );
		expect( content.hasAttribute( 'data-ask-page' ) ).toBe( true );
		unmount();
	} );

	// @longform The header is chrome, not content: it stays put while the
	// page scrolls, and the scrollbar belongs beside what moves. A box that
	// scrolls as a whole takes the header away with the rows and runs its
	// scrollbar the full height, through the header's own band.
	it( 'scrolls the area below the header, not the box around it', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'k',
				overflowY: 'auto',
				children: () => 'CHILD_MARKER',
			} )
		);

		const surface = container.querySelector(
			'.newspack-nodes-page-surface'
		);
		const content = container.querySelector(
			'.newspack-nodes-page-content'
		);

		expect( surface.style.overflowY ).toBe( 'hidden' );
		expect( content.style.overflowY ).toBe( 'auto' );
		// Header first, then the scroller: the header is outside what moves.
		expect( surface.firstElementChild.className ).toContain(
			'topology-header'
		);
		expect( content.previousElementSibling ).toBe(
			surface.firstElementChild
		);
		expect( content.textContent ).toContain( 'CHILD_MARKER' );
		unmount();
	} );

	// @longform A dashboard root is a flex item — `flex: 1 1 auto;
	// min-height: 0` — so the area
	// it sits in has to be a column. A block parent ignores both, and a
	// virtualized list sizing itself from `clientHeight` stops scrolling.
	it( 'lays the scrolling area out as a column, so a root grows into it', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'k',
				overflowY: 'hidden',
				children: () => null,
			} )
		);

		const content = container.querySelector(
			'.newspack-nodes-page-content'
		);
		expect( content.style.display ).toBe( 'flex' );
		expect( content.style.flexDirection ).toBe( 'column' );
		expect( content.style.minHeight ).toBe( '0' );
		unmount();
	} );

	it( 'leaves a page with no brief unaskable', () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'k',
				overflowY: 'scroll',
				children: () => null,
			} )
		);

		const content = container.querySelector(
			'.newspack-nodes-page-content'
		);
		expect( content.hasAttribute( 'data-ask' ) ).toBe( false );
		expect( content.hasAttribute( 'data-ask-page' ) ).toBe( false );
		unmount();
	} );

	it( "hands the debug overlay the page's own storage key", () => {
		const { container, unmount } = render(
			createElement( DashboardShell, {
				storageKey: 'newspack-nodes:debug:probe-shell',
				overflowY: 'auto',
				children: () => null,
			} )
		);

		expect( container.textContent ).toContain(
			'OVERLAY[newspack-nodes:debug:probe-shell]'
		);
		unmount();
	} );
} );

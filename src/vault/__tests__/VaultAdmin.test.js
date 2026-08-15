/**
 * VaultAdmin UI-surface tests — the thin React view over the Vault
 * server-credential node graph.
 *
 * The graph is owned by useVaultGraph (tested separately); here we mock it to
 * hand back spy CRUD callbacks, and we register a fixture `vault:view` node in
 * Core so the view can read its model via useNodeState. The rendered DOM reuses
 * the class names + ids the table uses (`wp-list-table`, `#new-server-id`,
 * `.event-aggregator-test`, …) so the styled result matches.
 */

jest.mock( '../hooks/useVaultGraph', () => {
	const actual = jest.requireActual( '../hooks/useVaultGraph' );
	return {
		__esModule: true,
		...actual,
		useVaultGraph: jest.fn(),
	};
} );

import { render, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import VaultAdmin from '../VaultAdmin';

const { useVaultGraph } = require( '../hooks/useVaultGraph' );

const SAMPLE_SERVERS = [
	{
		id: 'spoke-01',
		url: 'https://a.example.test',
		has_credentials: true,
		is_config: false,
	},
	{
		id: 'spoke-02',
		url: 'https://b.example.test',
		has_credentials: false,
		is_config: true,
	},
];

// Minimal vault:list view stand-in: setState notifies like the real Node.
function registerViewFixture( overrides = {} ) {
	const model = {
		servers: null,
		loading: true,
		error: null,
		...overrides,
	};
	const node = {
		registrations: { view: {} },
		setStateCache: {},
		register( event, listener, cb ) {
			this.registrations[ event ][ listener ] = cb;
			if ( event in this.setStateCache ) {
				cb( this.setStateCache[ event ] );
			}
		},
		unregister( event, listener ) {
			delete this.registrations[ event ]?.[ listener ];
		},
		setState( event, payload ) {
			this.setStateCache[ event ] = payload;
			Object.values( this.registrations[ event ] || {} ).forEach(
				( cb ) => cb( payload )
			);
		},
	};
	node.setState( 'view', model );
	Core.nodes.set( 'vault:list', node );
	return node;
}

// Set an input's value the React-controlled way and dispatch the input event.
function setInput( input, value ) {
	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLInputElement.prototype,
		'value'
	).set;
	act( () => {
		setter.call( input, value );
		input.dispatchEvent( new Event( 'input', { bubbles: true } ) );
	} );
}

// The add-server form now lives in a modal; open it before touching its fields.
function openAddModal( container ) {
	act( () => {
		container
			.querySelector( '.nodes-vault__add-trigger' )
			.dispatchEvent( new Event( 'click', { bubbles: true } ) );
	} );
}

// The confirm Modal is a body portal; scope button lookups to the dialog.
function dialogButton( label ) {
	const dialog = document.querySelector( '[role="dialog"]' ) || document;
	return Array.from( dialog.querySelectorAll( 'button' ) ).find(
		( btn ) => btn.textContent.trim() === label
	);
}

// Each verb's answer, as the hook publishes it: which server it was about,
// what it said, and a number so a repeat still registers.
const NO_ANSWER = { seq: 0, subject: null, error: null, pending: false };

describe( 'VaultAdmin', () => {
	let addServer;
	let removeServer;
	let testServer;
	let answers;
	const mounted = [];

	// Publish an answer, as a reply landing on the verb's node would.
	function answer( verb, { subject, error = null } ) {
		answers[ verb ] = {
			seq: answers[ verb ].seq + 1,
			subject,
			error,
			pending: false,
		};
		publish();
	}

	function publish() {
		useVaultGraph.mockReturnValue( {
			addServer,
			updateServer: jest.fn(),
			removeServer,
			testServer,
			addResult: answers.add,
			removeResult: answers.remove,
			testResult: answers.test,
		} );
		mounted.forEach( ( r ) => r.rerender( <VaultAdmin /> ) );
	}

	beforeEach( () => {
		Core.reset();
		addServer = jest.fn();
		removeServer = jest.fn();
		testServer = jest.fn();
		answers = {
			add: NO_ANSWER,
			remove: NO_ANSWER,
			test: NO_ANSWER,
		};
		useVaultGraph.mockClear();
		publish();
	} );

	afterEach( () => {
		while ( mounted.length ) {
			mounted.pop().unmount();
		}
	} );

	function mount() {
		const r = render( <VaultAdmin /> );
		mounted.push( r );
		return r;
	}

	it( 'mounts the graph (calls useVaultGraph)', () => {
		registerViewFixture();
		mount();
		expect( useVaultGraph ).toHaveBeenCalled();
	} );

	it( 'reads the table from the vault:list view (de-god split), not the old vault:view god node', () => {
		// Register the model under the OLD name; the table must NOT pick it up.
		const stale = registerViewFixture( {
			servers: SAMPLE_SERVERS,
			loading: false,
		} );
		Core.nodes.delete( 'vault:list' );
		Core.nodes.set( 'vault:view', stale );
		const { container } = mount();
		expect(
			container.querySelector( 'tr[data-server-id="spoke-01"]' )
		).toBeNull();
		// Now register under the new name — the table renders from vault:list.
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
	} );

	it( 'renders the server table with only the canonical table class', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const table = container.querySelector( 'table.newspack-nodes-table' );
		expect( table ).toBeTruthy();
		expect( table.className ).toBe( 'newspack-nodes-table' );
	} );

	it( 'keeps the WordPress notice paragraph inside the canonical error banner', () => {
		registerViewFixture( {
			servers: [],
			loading: false,
			error: 'Distinct vault failure',
		} );
		const { container } = mount();
		const banner = container.querySelector(
			'.newspack-nodes-error-banner'
		);

		expect( banner.firstElementChild?.tagName ).toBe( 'P' );
		expect( banner.firstElementChild?.textContent ).toBe(
			'Distinct vault failure'
		);
	} );

	it( 'gives the URL column more width than the ID, Status, and Actions columns', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const [ idTh, urlTh, statusTh, actionsTh ] = Array.from(
			container.querySelectorAll( 'thead th' )
		);
		const w = ( th ) => parseFloat( th.style.width );
		expect( w( urlTh ) ).toBeGreaterThan( w( idTh ) );
		expect( w( urlTh ) ).toBeGreaterThan( w( statusTh ) );
		expect( w( urlTh ) ).toBeGreaterThan( w( actionsTh ) );
	} );

	it( 'renders a row per server from the view model', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		expect(
			container.querySelector( 'tr[data-server-id="spoke-01"]' )
		).toBeTruthy();
		expect(
			container.querySelector( 'tr[data-server-id="spoke-02"]' )
		).toBeTruthy();
		expect( container.textContent ).toContain( 'spoke-01' );
		expect( container.textContent ).toContain( 'https://a.example.test' );
	} );

	it( 'shows the no-servers empty row when servers is an empty array', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		expect( container.textContent ).toContain( 'No servers configured' );
	} );

	it( 'does NOT render an enabled toggle button or enabled status icons', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		expect(
			container.querySelector( '.event-aggregator-toggle' )
		).toBeNull();
		expect( container.querySelector( '[data-enabled]' ) ).toBeNull();
		expect( container.querySelector( '.dashicons-yes-alt' ) ).toBeNull();
		expect( container.querySelector( '.dashicons-no' ) ).toBeNull();
	} );

	it( 'renders an Add Server trigger and keeps the form out of the DOM until opened', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		const trigger = container.querySelector( '.nodes-vault__add-trigger' );
		expect( trigger ).toBeTruthy();
		expect( trigger.classList.contains( 'button' ) ).toBe( true );
		// The form lives in a modal — its fields are not rendered yet.
		expect( container.querySelector( '#new-server-id' ) ).toBeNull();
		expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
	} );

	it( 'opens the add-server modal (with the form fields) when the trigger is clicked', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		const dialog = document.querySelector( '[role="dialog"]' );
		expect( dialog ).toBeTruthy();
		expect( dialog.className ).toBe( 'newspack-nodes-modal' );
		expect( dialog.querySelector( '#new-server-id' ) ).toBeTruthy();
		expect( dialog.querySelector( '#new-server-url' ) ).toBeTruthy();
		expect( dialog.querySelector( '#new-server-username' ) ).toBeTruthy();
		expect( dialog.querySelector( '#new-server-password' ) ).toBeTruthy();
		expect(
			dialog.querySelector( '#event-aggregator-add-server' )
		).toBeTruthy();
	} );

	it( 'groups Add Server and Cancel together in the modal footer (not split into the form body)', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		const footer = container.querySelector(
			'[role="dialog"] .newspack-nodes-modal__actions'
		);
		expect( footer ).toBeTruthy();
		// The primary submit lives in the footer, not in the form table.
		expect(
			footer.querySelector( '#event-aggregator-add-server' )
		).toBeTruthy();
		expect(
			container.querySelector(
				'table.form-table #event-aggregator-add-server'
			)
		).toBeNull();
		// Cancel is in the SAME footer as the submit.
		const cancel = Array.from( footer.querySelectorAll( 'button' ) ).find(
			( b ) => b.textContent.trim() === 'Cancel'
		);
		expect( cancel ).toBeTruthy();
	} );

	it( 'closes the add modal when the footer Cancel is clicked (without adding)', async () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		expect( document.querySelector( '[role="dialog"]' ) ).toBeTruthy();
		await act( async () => {
			dialogButton( 'Cancel' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
		expect( addServer ).not.toHaveBeenCalled();
	} );

	it( 'closes the add modal after a successful add', async () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		setInput( container.querySelector( '#new-server-id' ), 'spoke-09' );
		setInput(
			container.querySelector( '#new-server-url' ),
			'https://spoke.example'
		);
		await act( async () => {
			container
				.querySelector( '#event-aggregator-add-server' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).toHaveBeenCalled();
		await act( async () => answer( 'add', { subject: 'spoke-09' } ) );
		// The modal is gone once the add's answer lands.
		expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
		expect( container.querySelector( '#new-server-id' ) ).toBeNull();
	} );

	it( 'submits the add form via the graph callback with the field values', async () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		setInput( container.querySelector( '#new-server-id' ), 'spoke-09' );
		setInput(
			container.querySelector( '#new-server-url' ),
			'https://spoke.example'
		);
		setInput( container.querySelector( '#new-server-username' ), 'admin' );
		setInput( container.querySelector( '#new-server-password' ), 'secret' );
		await act( async () => {
			container
				.querySelector( '#event-aggregator-add-server' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).toHaveBeenCalledWith( {
			id: 'spoke-09',
			url: 'https://spoke.example',
			auth_username: 'admin',
			auth_password: 'secret',
		} );
	} );

	it( 'blocks add submission and shows a message when the id is empty', async () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		setInput(
			container.querySelector( '#new-server-url' ),
			'https://spoke.example'
		);
		await act( async () => {
			container
				.querySelector( '#event-aggregator-add-server' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).not.toHaveBeenCalled();
		expect( container.textContent ).toContain( 'ID is required' );
		// A blocked submission keeps the modal open so the user can correct it.
		expect( document.querySelector( '[role="dialog"]' ) ).toBeTruthy();
	} );

	it( 'blocks add submission when the URL is not https', async () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		setInput( container.querySelector( '#new-server-id' ), 'spoke-09' );
		setInput(
			container.querySelector( '#new-server-url' ),
			'http://insecure'
		);
		await act( async () => {
			container
				.querySelector( '#event-aggregator-add-server' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).not.toHaveBeenCalled();
		expect( container.textContent ).toContain( 'https://' );
	} );

	it( 'opens the confirm dialog (not removeServer) when remove is clicked', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		// The dialog shows the confirmation message; removeServer is deferred.
		expect( document.body.textContent ).toContain(
			'Are you sure you want to remove this server?'
		);
		expect( removeServer ).not.toHaveBeenCalled();
	} );

	it( 'calls removeServer when the dialog confirm is clicked', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () => {
			dialogButton( 'Remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		expect( removeServer ).toHaveBeenCalledWith( 'spoke-01' );
	} );

	it( 'does NOT call removeServer when the dialog is cancelled', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () => {
			dialogButton( 'Cancel' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		expect( removeServer ).not.toHaveBeenCalled();
		// Closing the dialog removes it from the document.
		expect( document.body.textContent ).not.toContain(
			'Are you sure you want to remove this server?'
		);
	} );

	it( 'calls testServer and shows the per-row test status on success', async () => {
		registerViewFixture( {
			servers: [ SAMPLE_SERVERS[ 0 ] ],
			loading: false,
		} );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-test' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		expect( testServer ).toHaveBeenCalledWith( 'spoke-01' );
		await act( async () => answer( 'test', { subject: 'spoke-01' } ) );
		expect( row.querySelector( '.test-status' ).textContent ).toContain(
			'Connected'
		);
	} );

	it( 'shows the per-row test failure message when the probe is refused', async () => {
		registerViewFixture( {
			servers: [ SAMPLE_SERVERS[ 0 ] ],
			loading: false,
		} );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-test' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () =>
			answer( 'test', {
				subject: 'spoke-01',
				error: 'connection refused',
			} )
		);
		expect( row.querySelector( '.test-status' ).textContent ).toContain(
			'connection refused'
		);
	} );

	it( 'shows the per-row failure message when a remove is refused', async () => {
		registerViewFixture( {
			servers: [ SAMPLE_SERVERS[ 0 ] ],
			loading: false,
		} );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () => {
			dialogButton( 'Remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () =>
			answer( 'remove', {
				subject: 'spoke-01',
				error: 'vault write refused',
			} )
		);
		expect( row.querySelector( '.test-status' ).textContent ).toContain(
			'vault write refused'
		);
		// The row stays put, so the failure must be visible on it.
		expect(
			container.querySelector( 'tr[data-server-id="spoke-01"]' )
		).toBeTruthy();
	} );

	it( 'renders a bare-string refusal verbatim, like every other surface', async () => {
		registerViewFixture( {
			servers: [ SAMPLE_SERVERS[ 0 ] ],
			loading: false,
		} );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-test' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () =>
			answer( 'test', { subject: 'spoke-01', error: 'vault sealed' } )
		);
		expect( row.querySelector( '.test-status' ).textContent ).toContain(
			'vault sealed'
		);
	} );

	it( 'renders modal Cancel buttons with the canonical .button class, not the inert button-tertiary', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openAddModal( container );
		const cancel = dialogButton( 'Cancel' );
		expect( cancel.classList.contains( 'button' ) ).toBe( true );
		expect( cancel.classList.contains( 'button-tertiary' ) ).toBe( false );
	} );

	it( 'renders the confirm-remove Cancel button without button-tertiary', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.event-aggregator-remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		const cancel = dialogButton( 'Cancel' );
		expect( cancel.classList.contains( 'button' ) ).toBe( true );
		expect( cancel.classList.contains( 'button-tertiary' ) ).toBe( false );
	} );

	it( 'shows the error banner from the view model', () => {
		registerViewFixture( {
			servers: SAMPLE_SERVERS,
			loading: false,
			error: 'registry down',
		} );
		const { container } = mount();
		expect( container.textContent ).toContain( 'registry down' );
	} );

	it( 'falls back to a loading model when the view node is absent', () => {
		// No fixture: useNodeState yields undefined; the view still renders.
		const { container } = mount();
		expect(
			container.querySelector( 'table.newspack-nodes-table' )
		).toBeTruthy();
		expect(
			container.querySelector( '.nodes-vault__add-trigger' )
		).toBeTruthy();
	} );
} );

/**
 * VaultAdmin UI-surface tests — the thin React view over the Vault
 * server-credential node graph.
 *
 * The graph is owned by useVaultGraph (tested separately); here we mock it to
 * hand back spy CRUD callbacks, and we register a fixture `vault:view` node in
 * Core so the view can read its model via useNodeState. The rendered DOM reuses
 * the class names + ids the table uses (`wp-list-table`, `#vault-server-id`,
 * `.nodes-vault__test`, …) so the styled result matches.
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
		auth_username: 'reader-4471',
		has_credentials: true,
		is_config: false,
	},
	{
		id: 'spoke-02',
		url: 'https://b.example.test',
		auth_username: '',
		has_credentials: false,
		is_config: true,
	},
];

let model;
let publish = () => {};

// The graph hook owns the table's model now; the fixture seeds what it returns.
function registerViewFixture( overrides = {} ) {
	model = {
		servers: null,
		loading: true,
		error: null,
		...overrides,
	};
	publish();
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

// Open one row's edit modal by clicking its Edit button.
function openEditModal( container, id ) {
	act( () => {
		container
			.querySelector( `tr[data-server-id="${ id }"] .nodes-vault__edit` )
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

describe( 'VaultAdmin', () => {
	let addServer;
	let removeServer;
	let testServer;
	let updateServer;
	let graphOpts = {};
	// What the graph reports as outstanding (as a `test`); the screen asks
	// rather than keeping a flag of its own.
	let pendingSubjects = [];
	const mounted = [];

	// A reply, already addressed: the graph hands the screen the answer and
	// the SUBJECT it named, exactly as the reply path delivered it.
	function answer( verb, { subject, error = null } ) {
		act( () => graphOpts.onAnswer?.( { verb, subject, error } ) );
	}

	publish = function () {
		useVaultGraph.mockImplementation( ( opts = {} ) => {
			graphOpts = opts;
			return {
				...model,
				addServer,
				updateServer,
				removeServer,
				testServer,
				pendingVerb: ( subject ) =>
					pendingSubjects.includes( subject ) ? 'test' : null,
			};
		} );
		mounted.forEach( ( r ) => r.rerender( <VaultAdmin /> ) );
	};

	beforeEach( () => {
		Core.reset();
		addServer = jest.fn();
		removeServer = jest.fn();
		testServer = jest.fn();
		updateServer = jest.fn();
		graphOpts = {};
		pendingSubjects = [];
		model = { servers: null, loading: true, error: null };
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

	// @longform The row shows the work while a verb about it is outstanding —
	// and it asks the graph, which owns the outbox, instead of keeping a flag
	// flipped at the click and cleared in the answer. A flag beside every call
	// site is the thing that goes stale when a path forgets to clear it.
	it( 'shows the outstanding row as working, and only that row', () => {
		pendingSubjects = [ 'spoke-01' ];
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const rows = container.querySelectorAll( 'tbody tr' );
		const testButton = ( row ) =>
			Array.from( row.querySelectorAll( 'button' ) ).find( ( b ) =>
				/test/i.test( b.textContent )
			);
		expect( rows[ 0 ].textContent ).toContain( 'Testing…' );
		expect( testButton( rows[ 0 ] ).disabled ).toBe( true );
		expect( testButton( rows[ 1 ] ).disabled ).toBe( false );
	} );

	it( 'mounts the graph (calls useVaultGraph)', () => {
		registerViewFixture();
		mount();
		expect( useVaultGraph ).toHaveBeenCalled();
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
		expect( container.querySelector( '#vault-server-id' ) ).toBeNull();
		expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
	} );

	it( 'opens the add-server modal (with the form fields) when the trigger is clicked', () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		const dialog = document.querySelector( '[role="dialog"]' );
		expect( dialog ).toBeTruthy();
		expect( dialog.className ).toBe( 'newspack-nodes-modal' );
		expect( dialog.querySelector( '#vault-server-id' ) ).toBeTruthy();
		expect( dialog.querySelector( '#vault-server-url' ) ).toBeTruthy();
		expect( dialog.querySelector( '#vault-server-username' ) ).toBeTruthy();
		expect( dialog.querySelector( '#vault-server-password' ) ).toBeTruthy();
		expect( dialog.querySelector( '#vault-server-save' ) ).toBeTruthy();
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
		expect( footer.querySelector( '#vault-server-save' ) ).toBeTruthy();
		expect(
			container.querySelector( 'table.form-table #vault-server-save' )
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
		setInput( container.querySelector( '#vault-server-id' ), 'spoke-09' );
		setInput(
			container.querySelector( '#vault-server-url' ),
			'https://spoke.example'
		);
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).toHaveBeenCalled();
		await act( async () => answer( 'add', { subject: 'spoke-09' } ) );
		// The modal is gone once the add's answer lands.
		expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
		expect( container.querySelector( '#vault-server-id' ) ).toBeNull();
	} );

	it( 'submits the add form via the graph callback with the field values', async () => {
		registerViewFixture( { servers: [], loading: false } );
		const { container } = mount();
		openAddModal( container );
		setInput( container.querySelector( '#vault-server-id' ), 'spoke-09' );
		setInput(
			container.querySelector( '#vault-server-url' ),
			'https://spoke.example'
		);
		setInput(
			container.querySelector( '#vault-server-username' ),
			'admin'
		);
		setInput(
			container.querySelector( '#vault-server-password' ),
			'secret'
		);
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
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
			container.querySelector( '#vault-server-url' ),
			'https://spoke.example'
		);
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
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
		setInput( container.querySelector( '#vault-server-id' ), 'spoke-09' );
		setInput(
			container.querySelector( '#vault-server-url' ),
			'http://insecure'
		);
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).not.toHaveBeenCalled();
		expect( container.textContent ).toContain( 'https://' );
	} );

	// ---------------------------------------------------------------------
	// Edit — the same form the add uses, seeded from the row.
	// ---------------------------------------------------------------------

	it( 'renders an Edit button on every row', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		expect(
			container.querySelectorAll( 'tbody .nodes-vault__edit' )
		).toHaveLength( 2 );
	} );

	it( 'seeds the edit form with the row it was opened from', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openEditModal( container, 'spoke-01' );
		const dialog = document.querySelector( '[role="dialog"]' );
		expect( dialog.textContent ).toContain( 'Edit Server' );
		expect( dialog.querySelector( '#vault-server-id' ).value ).toBe(
			'spoke-01'
		);
		expect( dialog.querySelector( '#vault-server-url' ).value ).toBe(
			'https://a.example.test'
		);
		expect( dialog.querySelector( '#vault-server-username' ).value ).toBe(
			'reader-4471'
		);
		// A stored password is never sent to the browser, so it starts blank.
		expect( dialog.querySelector( '#vault-server-password' ).value ).toBe(
			''
		);
	} );

	it( 'saves an edit against the id the row HAS, carrying the new one as a field', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openEditModal( container, 'spoke-01' );
		setInput( container.querySelector( '#vault-server-id' ), 'spoke-77' );
		setInput(
			container.querySelector( '#vault-server-url' ),
			'https://moved.example.test'
		);
		setInput(
			container.querySelector( '#vault-server-username' ),
			'editor-6612'
		);
		setInput(
			container.querySelector( '#vault-server-password' ),
			'pw-8823'
		);
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( addServer ).not.toHaveBeenCalled();
		expect( updateServer ).toHaveBeenCalledWith( 'spoke-01', {
			id: 'spoke-77',
			url: 'https://moved.example.test',
			auth_username: 'editor-6612',
			auth_password: 'pw-8823',
		} );
	} );

	it( 'leaves the password empty when the operator types none', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openEditModal( container, 'spoke-01' );
		setInput(
			container.querySelector( '#vault-server-url' ),
			'https://moved.example.test'
		);
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		expect( updateServer ).toHaveBeenCalledWith(
			'spoke-01',
			expect.objectContaining( { auth_password: '' } )
		);
	} );

	it( 'closes the edit modal on the update answer, which names the OLD id', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openEditModal( container, 'spoke-01' );
		setInput( container.querySelector( '#vault-server-id' ), 'spoke-77' );
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		await act( async () => answer( 'update', { subject: 'spoke-01' } ) );
		expect( document.querySelector( '[role="dialog"]' ) ).toBeNull();
	} );

	it( 'keeps the edit modal open and shows the refusal when the update fails', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openEditModal( container, 'spoke-01' );
		await act( async () => {
			container
				.querySelector( '#vault-server-save' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) );
		} );
		await act( async () =>
			answer( 'update', {
				subject: 'spoke-01',
				error: 'server already exists: spoke-77',
			} )
		);
		expect( document.querySelector( '[role="dialog"]' ) ).toBeTruthy();
		expect( document.body.textContent ).toContain(
			'server already exists: spoke-77'
		);
	} );

	// A config-file server is pinned by the file; offering buttons that can
	// only ever be refused is worse than not offering them.
	it( 'disables Edit and Remove on a config-file server', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const pinned = container.querySelector(
			'tr[data-server-id="spoke-02"]'
		);
		expect( pinned.querySelector( '.nodes-vault__edit' ).disabled ).toBe(
			true
		);
		expect( pinned.querySelector( '.nodes-vault__remove' ).disabled ).toBe(
			true
		);
		const editable = container.querySelector(
			'tr[data-server-id="spoke-01"]'
		);
		expect( editable.querySelector( '.nodes-vault__edit' ).disabled ).toBe(
			false
		);
	} );

	it( 'opens the add modal blank even after an edit was opened first', () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		openEditModal( container, 'spoke-01' );
		act( () => {
			dialogButton( 'Cancel' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		openAddModal( container );
		const dialog = document.querySelector( '[role="dialog"]' );
		expect( dialog.textContent ).toContain( 'Add New Server' );
		expect( dialog.querySelector( '#vault-server-id' ).value ).toBe( '' );
		expect( dialog.querySelector( '#vault-server-url' ).value ).toBe( '' );
	} );

	it( 'opens the confirm dialog (not removeServer) when remove is clicked', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.nodes-vault__remove' ).dispatchEvent(
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
			row.querySelector( '.nodes-vault__remove' ).dispatchEvent(
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
			row.querySelector( '.nodes-vault__remove' ).dispatchEvent(
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
			row.querySelector( '.nodes-vault__test' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		expect( testServer ).toHaveBeenCalledWith( 'spoke-01' );
		await act( async () => answer( 'test', { subject: 'spoke-01' } ) );
		expect( row.querySelector( '.test-status' ).textContent ).toContain(
			'Connected'
		);
	} );

	// @longform Two rows probed in the same second are two subjects, and each
	// row shows its OWN answer. One node per verb across every row cannot do
	// that: the second reply lands where the first did, and the first row's
	// status line goes blank while its result is still the current truth.
	it( 'keeps each row’s answer when a second row is probed', async () => {
		registerViewFixture( { servers: SAMPLE_SERVERS, loading: false } );
		const { container } = mount();
		const rows = () => container.querySelectorAll( 'tbody tr' );

		act( () =>
			rows()[ 0 ]
				.querySelector( '.nodes-vault__test' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) )
		);
		answer( 'test', { subject: 'spoke-01' } );
		expect(
			rows()[ 0 ].querySelector( '.test-status' ).textContent
		).toContain( 'Connected' );

		act( () =>
			rows()[ 1 ]
				.querySelector( '.nodes-vault__test' )
				.dispatchEvent( new Event( 'click', { bubbles: true } ) )
		);
		answer( 'test', { subject: 'spoke-02', error: 'refused' } );

		// The second row's failure did not erase the first row's success.
		expect(
			rows()[ 0 ].querySelector( '.test-status' ).textContent
		).toContain( 'Connected' );
		expect(
			rows()[ 1 ].querySelector( '.test-status' ).textContent
		).toContain( 'refused' );
	} );

	it( 'shows the per-row test failure message when the probe is refused', async () => {
		registerViewFixture( {
			servers: [ SAMPLE_SERVERS[ 0 ] ],
			loading: false,
		} );
		const { container } = mount();
		const row = container.querySelector( 'tr[data-server-id="spoke-01"]' );
		await act( async () => {
			row.querySelector( '.nodes-vault__test' ).dispatchEvent(
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
			row.querySelector( '.nodes-vault__remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () => {
			dialogButton( 'Remove' ).dispatchEvent(
				new Event( 'click', { bubbles: true } )
			);
		} );
		await act( async () =>
			answer( 'delete', {
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
			row.querySelector( '.nodes-vault__test' ).dispatchEvent(
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
			row.querySelector( '.nodes-vault__remove' ).dispatchEvent(
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

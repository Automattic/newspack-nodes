import { render, screen, fireEvent } from '@testing-library/react';
import TopologySettingsPanel from '../TopologySettingsPanel';
import { DraftProvider } from '../../DraftContext';

// The panel edits the document, so it reads and dispatches through the draft
// seam. `dispatch` stands in for the reducer; `var` carries the whole map.
function renderInDraft( draft, dispatch, extra = {} ) {
	render(
		<DraftProvider draft={ draft } dispatch={ dispatch }>
			<TopologySettingsPanel
				configDefaultPartitions={ 2 }
				onClose={ () => {} }
				{ ...extra }
			/>
		</DraftProvider>
	);
}

// No jest-dom in this repo — assert over bare DOM (value/getAttribute/null).
function setup( frontmatter = {}, extra = {} ) {
	const dispatch = jest.fn();
	renderInDraft( { frontmatter }, dispatch, extra );
	return { dispatch };
}

describe( 'TopologySettingsPanel', () => {
	it( 'owns the canonical non-graph provider classes when portaled to body', () => {
		setup( {} );
		const dialog = screen.getByRole( 'dialog', {
			name: /topology settings/i,
		} );

		expect( dialog.className ).toBe(
			'newspack-nodes-card newspack-nodes-card--elevated topology-settings-panel newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui'
		);
		expect( dialog.parentElement ).toBe( document.body );
		expect( dialog.classList.contains( 'topology-app' ) ).toBe( false );
	} );

	it( 'does not repeat provider classes when portaled into the themed hub', () => {
		const provider = document.createElement( 'div' );
		provider.className =
			'newspack-nodes-skin-root newspack-nodes-theme newspack-nodes-ui';
		const hub = document.createElement( 'div' );
		hub.className = 'nodes-devtools-hub';
		provider.appendChild( hub );
		document.body.appendChild( provider );

		try {
			setup( {} );
			const dialog = screen.getByRole( 'dialog', {
				name: /topology settings/i,
			} );
			expect( dialog.parentElement ).toBe( hub );
			expect( dialog.className ).toBe(
				'newspack-nodes-card newspack-nodes-card--elevated topology-settings-panel'
			);
			expect( dialog.closest( '.newspack-nodes-theme' ) ).toBe(
				provider
			);
			expect(
				provider.querySelectorAll( '.newspack-nodes-theme' )
			).toHaveLength( 0 );
		} finally {
			provider.remove();
		}
	} );

	it( 'shows the config default as the partitions placeholder when unset', () => {
		setup( {} );
		const input = screen.getByLabelText( /partitions/i );
		expect( input.value ).toBe( '' );
		expect( input.getAttribute( 'placeholder' ) ).toBe( '2' );
	} );

	it( 'clamps partitions to 1..16 and commits', () => {
		const { dispatch } = setup( {} );
		fireEvent.change( screen.getByLabelText( /partitions/i ), {
			target: { value: '99' },
		} );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: { num_partitions: '16' },
		} );
	} );

	it( 'clearing partitions removes the key (config default)', () => {
		const { dispatch } = setup( { num_partitions: '4' } );
		fireEvent.change( screen.getByLabelText( /partitions/i ), {
			target: { value: '' },
		} );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: {},
		} );
	} );

	it( 'edits a generic var value and commits', () => {
		const { dispatch } = setup( { custom_thing: 'old' } );
		fireEvent.change( screen.getByLabelText( /value for custom_thing/i ), {
			target: { value: 'new' },
		} );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: { custom_thing: 'new' },
		} );
	} );

	it( 'adds a valid generic var', () => {
		const { dispatch } = setup( {} );
		fireEvent.change( screen.getByLabelText( /new variable name/i ), {
			target: { value: 'foo' },
		} );
		fireEvent.change( screen.getByLabelText( /new variable value/i ), {
			target: { value: 'bar' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: /^add$/i } ) );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: { foo: 'bar' },
		} );
	} );

	it( 'rejects an invalid var name (contains colon)', () => {
		const { dispatch } = setup( {} );
		fireEvent.change( screen.getByLabelText( /new variable name/i ), {
			target: { value: 'config:x' },
		} );
		fireEvent.change( screen.getByLabelText( /new variable value/i ), {
			target: { value: 'y' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: /^add$/i } ) );
		expect( dispatch ).not.toHaveBeenCalled();
		expect( screen.queryByRole( 'alert' ) ).not.toBeNull();
	} );

	it( 'rejects a name already in use, including reserved keys', () => {
		const { dispatch } = setup( { custom_thing: 'x' } );
		fireEvent.change( screen.getByLabelText( /new variable name/i ), {
			target: { value: 'num_partitions' },
		} );
		fireEvent.change( screen.getByLabelText( /new variable value/i ), {
			target: { value: '3' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: /^add$/i } ) );
		expect( dispatch ).not.toHaveBeenCalled();
		expect( screen.queryByRole( 'alert' ) ).not.toBeNull();
	} );

	it( 'removes a generic var via its × button', () => {
		const { dispatch } = setup( { custom_thing: 'x' } );
		fireEvent.click( screen.getByLabelText( /remove custom_thing/i ) );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: {},
		} );
	} );

	it( 'stale_timeout floors to 1 and clears non-numeric to empty', () => {
		const { dispatch } = setup( { stale_timeout: '120' } );
		const input = screen.getByLabelText( /stale timeout/i );
		fireEvent.change( input, { target: { value: '0' } } );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: { stale_timeout: '1' },
		} );
		fireEvent.change( input, { target: { value: 'abc' } } );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: {},
		} );
	} );

	it( 'strips newlines and semicolons from a generic value', () => {
		const { dispatch } = setup( { custom_thing: 'x' } );
		fireEvent.change( screen.getByLabelText( /value for custom_thing/i ), {
			target: { value: 'a;b\nc' },
		} );
		expect( dispatch ).toHaveBeenLastCalledWith( {
			type: 'var',
			frontmatter: { custom_thing: 'abc' },
		} );
	} );

	it( 'does not render recognized keys as generic rows', () => {
		setup( { num_partitions: '4', stale_timeout: '120' } );
		expect(
			screen.queryByLabelText( /value for num_partitions/i )
		).toBeNull();
		expect( screen.getByLabelText( /partitions/i ).value ).toBe( '4' );
	} );
} );

/**
 * The secure level is a STATEMENT, not frontmatter — it stays the verb an
 * operator would type, and it is greppable, which is half its value. So it
 * rides its own prop and its own callback rather than the frontmatter map.
 */
describe( 'TopologySettingsPanel secure level', () => {
	function setupSecure( secureLevel = '' ) {
		const dispatch = jest.fn();
		renderInDraft( { frontmatter: {}, secureLevel }, dispatch );
		return { dispatch };
	}

	it( 'defaults to declaring nothing', () => {
		setupSecure();
		expect( screen.getByLabelText( /secure level/i ).value ).toBe( '' );
	} );

	it( 'reflects a declared level', () => {
		setupSecure( '3' );
		expect( screen.getByLabelText( /secure level/i ).value ).toBe( '3' );
	} );

	it( 'commits a chosen level', () => {
		const { dispatch } = setupSecure();
		fireEvent.change( screen.getByLabelText( /secure level/i ), {
			target: { value: '2' },
		} );
		expect( dispatch ).toHaveBeenCalledWith( {
			type: 'secure',
			level: '2',
		} );
	} );

	it( 'commits insecure', () => {
		const { dispatch } = setupSecure();
		fireEvent.change( screen.getByLabelText( /secure level/i ), {
			target: { value: 'insecure' },
		} );
		expect( dispatch ).toHaveBeenCalledWith( {
			type: 'secure',
			level: 'insecure',
		} );
	} );
} );

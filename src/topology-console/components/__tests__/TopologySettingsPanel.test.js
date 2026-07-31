import { render, screen, fireEvent } from '@testing-library/react';
import TopologySettingsPanel from '../TopologySettingsPanel';

// No jest-dom in this repo — assert over bare DOM (value/getAttribute/null).
function setup( frontmatter = {}, extra = {} ) {
	const onChange = jest.fn();
	render(
		<TopologySettingsPanel
			frontmatter={ frontmatter }
			configDefaultPartitions={ 2 }
			onChange={ onChange }
			onClose={ () => {} }
			{ ...extra }
		/>
	);
	return { onChange };
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
		const { onChange } = setup( {} );
		fireEvent.change( screen.getByLabelText( /partitions/i ), {
			target: { value: '99' },
		} );
		expect( onChange ).toHaveBeenLastCalledWith( { num_partitions: '16' } );
	} );

	it( 'clearing partitions removes the key (config default)', () => {
		const { onChange } = setup( { num_partitions: '4' } );
		fireEvent.change( screen.getByLabelText( /partitions/i ), {
			target: { value: '' },
		} );
		expect( onChange ).toHaveBeenLastCalledWith( {} );
	} );

	it( 'edits a generic var value and commits', () => {
		const { onChange } = setup( { custom_thing: 'old' } );
		fireEvent.change( screen.getByLabelText( /value for custom_thing/i ), {
			target: { value: 'new' },
		} );
		expect( onChange ).toHaveBeenLastCalledWith( { custom_thing: 'new' } );
	} );

	it( 'adds a valid generic var', () => {
		const { onChange } = setup( {} );
		fireEvent.change( screen.getByLabelText( /new variable name/i ), {
			target: { value: 'foo' },
		} );
		fireEvent.change( screen.getByLabelText( /new variable value/i ), {
			target: { value: 'bar' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: /^add$/i } ) );
		expect( onChange ).toHaveBeenLastCalledWith( { foo: 'bar' } );
	} );

	it( 'rejects an invalid var name (contains colon)', () => {
		const { onChange } = setup( {} );
		fireEvent.change( screen.getByLabelText( /new variable name/i ), {
			target: { value: 'config:x' },
		} );
		fireEvent.change( screen.getByLabelText( /new variable value/i ), {
			target: { value: 'y' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: /^add$/i } ) );
		expect( onChange ).not.toHaveBeenCalled();
		expect( screen.queryByRole( 'alert' ) ).not.toBeNull();
	} );

	it( 'rejects a name already in use, including reserved keys', () => {
		const { onChange } = setup( { custom_thing: 'x' } );
		fireEvent.change( screen.getByLabelText( /new variable name/i ), {
			target: { value: 'num_partitions' },
		} );
		fireEvent.change( screen.getByLabelText( /new variable value/i ), {
			target: { value: '3' },
		} );
		fireEvent.click( screen.getByRole( 'button', { name: /^add$/i } ) );
		expect( onChange ).not.toHaveBeenCalled();
		expect( screen.queryByRole( 'alert' ) ).not.toBeNull();
	} );

	it( 'removes a generic var via its × button', () => {
		const { onChange } = setup( { custom_thing: 'x' } );
		fireEvent.click( screen.getByLabelText( /remove custom_thing/i ) );
		expect( onChange ).toHaveBeenLastCalledWith( {} );
	} );

	it( 'stale_timeout floors to 1 and clears non-numeric to empty', () => {
		const { onChange } = setup( { stale_timeout: '120' } );
		const input = screen.getByLabelText( /stale timeout/i );
		fireEvent.change( input, { target: { value: '0' } } );
		expect( onChange ).toHaveBeenLastCalledWith( { stale_timeout: '1' } );
		fireEvent.change( input, { target: { value: 'abc' } } );
		expect( onChange ).toHaveBeenLastCalledWith( {} );
	} );

	it( 'strips newlines and semicolons from a generic value', () => {
		const { onChange } = setup( { custom_thing: 'x' } );
		fireEvent.change( screen.getByLabelText( /value for custom_thing/i ), {
			target: { value: 'a;b\nc' },
		} );
		expect( onChange ).toHaveBeenLastCalledWith( { custom_thing: 'abc' } );
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
		const onSecureLevelChange = jest.fn();
		render(
			<TopologySettingsPanel
				frontmatter={ {} }
				configDefaultPartitions={ 2 }
				secureLevel={ secureLevel }
				onChange={ () => {} }
				onSecureLevelChange={ onSecureLevelChange }
				onClose={ () => {} }
			/>
		);
		return { onSecureLevelChange };
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
		const { onSecureLevelChange } = setupSecure();
		fireEvent.change( screen.getByLabelText( /secure level/i ), {
			target: { value: '2' },
		} );
		expect( onSecureLevelChange ).toHaveBeenCalledWith( '2' );
	} );

	it( 'commits insecure', () => {
		const { onSecureLevelChange } = setupSecure();
		fireEvent.change( screen.getByLabelText( /secure level/i ), {
			target: { value: 'insecure' },
		} );
		expect( onSecureLevelChange ).toHaveBeenCalledWith( 'insecure' );
	} );
} );

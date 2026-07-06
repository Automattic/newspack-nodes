/**
 * CtorField vault_id — dropdown of registered Vault entries, text-input
 * fallback when the catalog is empty, and preservation of a stored value
 * that isn't in the fetched list (config token / not-yet-created id).
 */

import { render, fireEvent } from '@testing-library/react';
import { CtorField } from '../CtorField';

const spec = { name: 'vault_id', type: 'vault_id', required: true };
const noop = () => {};

describe( 'CtorField vault_id', () => {
	it( 'renders a select of vault ids with url in the label', () => {
		const onChange = jest.fn();
		const { container } = render(
			<CtorField
				spec={ spec }
				value=""
				onChange={ onChange }
				vaults={ [
					{ id: 'aspen', url: 'https://a.example' },
					{ id: 'github', url: '' },
				] }
			/>
		);
		const select = container.querySelector( '#topology-ctor-vault_id' );
		expect( select.tagName ).toBe( 'SELECT' );
		// (pick a vault) + aspen + github.
		expect( select.options.length ).toBe( 3 );
		expect( select.options[ 1 ].textContent ).toBe(
			'aspen — https://a.example'
		);
		expect( select.options[ 2 ].textContent ).toBe( 'github' );
		fireEvent.change( select, { target: { value: 'aspen' } } );
		expect( onChange ).toHaveBeenCalledWith( 'aspen' );
	} );

	it( 'falls back to a text input when no vaults are registered', () => {
		const { container } = render(
			<CtorField spec={ spec } value="" onChange={ noop } vaults={ [] } />
		);
		const input = container.querySelector( '#topology-ctor-vault_id' );
		expect( input.tagName ).toBe( 'INPUT' );
	} );

	it( 'preserves a stored value that is not in the fetched list', () => {
		const { container } = render(
			<CtorField
				spec={ spec }
				value="<config:ai_vault>"
				onChange={ noop }
				vaults={ [ { id: 'aspen', url: '' } ] }
			/>
		);
		const select = container.querySelector( '#topology-ctor-vault_id' );
		expect( select.value ).toBe( '<config:ai_vault>' );
		expect(
			[ ...select.options ].some(
				( o ) => '<config:ai_vault>' === o.value
			)
		).toBe( true );
	} );
} );

/* eslint-env jest */
/**
 * RefreshPicker — the one cadence select: it shows the chosen option by its
 * label and hands back the option's own value, a number or a string as the
 * options declare it.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import RefreshPicker from '../RefreshPicker';

const SECONDS = [
	{ label: 'Half a beat 7890', value: 0.5 },
	{ label: 'Three beats 7890', value: 3 },
];

const MILLISECONDS = [
	{ label: 'Quick 7891', value: '1500' },
	{ label: 'Slow 7891', value: '45000' },
];

it( 'selects the chosen option and names itself a refresh interval', () => {
	render(
		<RefreshPicker value={ 3 } options={ SECONDS } onChange={ () => {} } />
	);
	const select = screen.getByRole( 'combobox', {
		name: 'Refresh interval',
	} );
	expect( select.value ).toBe( '3' );
	expect(
		screen.getAllByRole( 'option' ).map( ( option ) => option.textContent )
	).toEqual( [ 'Half a beat 7890', 'Three beats 7890' ] );
} );

it( 'hands back a numeric option as the number it declares', () => {
	const onChange = jest.fn();
	render(
		<RefreshPicker value={ 3 } options={ SECONDS } onChange={ onChange } />
	);
	fireEvent.change( screen.getByRole( 'combobox' ), {
		target: { value: '0.5' },
	} );
	expect( onChange ).toHaveBeenCalledWith( 0.5 );
} );

it( 'hands back a string option as the string it declares', () => {
	const onChange = jest.fn();
	render(
		<RefreshPicker
			value="1500"
			options={ MILLISECONDS }
			onChange={ onChange }
			title="Pick a cadence 7891"
		/>
	);
	const select = screen.getByRole( 'combobox' );
	expect( select.getAttribute( 'title' ) ).toBe( 'Pick a cadence 7891' );
	fireEvent.change( select, { target: { value: '45000' } } );
	expect( onChange ).toHaveBeenCalledWith( '45000' );
} );

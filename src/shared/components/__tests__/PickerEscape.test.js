/* eslint-env jest */
/**
 * `PickerEscape` hears a key before the picker it wraps does, and hands an
 * Escape on to `onEscape` only while the picker's list is closed, read off
 * its input as `aria-expanded="false"`. It holds back an Escape pressed
 * while an input method is composing text, which takes its own Escape.
 * `composing` is that test, and reads both shapes a browser reports it in.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import PickerEscape, { composing } from '../PickerEscape';

/**
 * A picker whose input reads the list as open or closed.
 *
 * @param {Object}     props
 * @param {string}     props.expanded   The input's `aria-expanded`.
 * @param {() => void} [props.onEscape] Takes the Escape handed on.
 * @return {import('react').ReactElement} The wrapped input.
 */
const Picker = ( { expanded, onEscape } ) => (
	<PickerEscape onEscape={ onEscape }>
		<input
			role="combobox"
			aria-label="Ostrander desk"
			aria-controls="ostrander-desk-list"
			aria-expanded={ expanded }
		/>
	</PickerEscape>
);

const input = () => screen.getByRole( 'combobox', { name: 'Ostrander desk' } );

describe( 'PickerEscape', () => {
	it( 'hands an Escape on while the list is closed', () => {
		const onEscape = jest.fn();
		render( <Picker expanded="false" onEscape={ onEscape } /> );

		fireEvent.keyDown( input(), { key: 'Escape', code: 'Escape' } );

		expect( onEscape ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'holds an Escape while the list is open', () => {
		const onEscape = jest.fn();
		render( <Picker expanded="true" onEscape={ onEscape } /> );

		fireEvent.keyDown( input(), { key: 'Escape', code: 'Escape' } );

		expect( onEscape ).not.toHaveBeenCalled();
	} );

	it( 'holds an Escape while an input method is composing', () => {
		const onEscape = jest.fn();
		render( <Picker expanded="false" onEscape={ onEscape } /> );

		fireEvent.keyDown( input(), {
			key: 'Escape',
			code: 'Escape',
			isComposing: true,
		} );
		fireEvent.keyDown( input(), {
			key: 'Escape',
			code: 'Escape',
			keyCode: 229,
		} );

		expect( onEscape ).not.toHaveBeenCalled();
	} );

	it( 'hands on no key but Escape', () => {
		const onEscape = jest.fn();
		render( <Picker expanded="false" onEscape={ onEscape } /> );

		fireEvent.keyDown( input(), { key: 'Enter', code: 'Enter' } );

		expect( onEscape ).not.toHaveBeenCalled();
	} );

	it( 'leaves a picker with no onEscape to take its Escape alone', () => {
		render( <Picker expanded="false" /> );

		expect( () =>
			fireEvent.keyDown( input(), { key: 'Escape', code: 'Escape' } )
		).not.toThrow();
	} );
} );

describe( 'composing', () => {
	it( 'reads a composition off isComposing or the 229 keyCode', () => {
		expect(
			composing( { nativeEvent: { isComposing: true }, keyCode: 27 } )
		).toBe( true );
		expect(
			composing( { nativeEvent: { isComposing: false }, keyCode: 229 } )
		).toBe( true );
		expect(
			composing( { nativeEvent: { isComposing: false }, keyCode: 27 } )
		).toBe( false );
	} );
} );

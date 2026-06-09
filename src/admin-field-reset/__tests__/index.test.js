/**
 * Tests for the per-field reset toggle, focused on the pending-reset visual:
 * arming a reset must show the field's DEFAULT, not blanket-clear it. A
 * default-enabled checkbox that reads as unchecked while a reset is pending is
 * the bug — Save restores the default, but the pending state lied about it.
 */

import { initFieldReset } from '../index.js';

/**
 * Build a wired reset wrapper holding one checkbox + a toggle button.
 *
 * @param {Object}  opts              Checkbox setup.
 * @param {boolean} opts.checked      Initial checked state.
 * @param {string}  opts.resetDefault data-nn-reset-default value ('1'/'0'), or undefined to omit.
 * @return {Object} The created wrapper, box, and toggle elements.
 */
const makeCheckboxWrapper = ( { checked, resetDefault } ) => {
	const wrapper = document.createElement( 'div' );
	wrapper.setAttribute( 'data-nn-reset', 'opt[enable_logging]' );

	const box = document.createElement( 'input' );
	box.type = 'checkbox';
	box.checked = checked;
	if ( undefined !== resetDefault ) {
		box.setAttribute( 'data-nn-reset-default', resetDefault );
	}
	wrapper.appendChild( box );

	const toggle = document.createElement( 'button' );
	toggle.setAttribute( 'data-nn-reset-toggle', '' );
	wrapper.appendChild( toggle );

	document.body.appendChild( wrapper );
	initFieldReset( wrapper.parentNode );
	return { wrapper, box, toggle };
};

afterEach( () => {
	document.body.innerHTML = '';
} );

test( 'arming reset on a default-enabled checkbox shows it checked', () => {
	const { box, toggle } = makeCheckboxWrapper( {
		checked: true,
		resetDefault: '1',
	} );

	toggle.click(); // arm the reset

	expect( box.checked ).toBe( true );
} );

test( 'arming reset on a default-disabled checkbox shows it unchecked', () => {
	const { box, toggle } = makeCheckboxWrapper( {
		checked: true,
		resetDefault: '0',
	} );

	toggle.click();

	expect( box.checked ).toBe( false );
} );

test( 'toggling reset off restores the pre-reset state', () => {
	const { box, toggle } = makeCheckboxWrapper( {
		checked: false,
		resetDefault: '1',
	} );

	toggle.click(); // arm: shows default (checked)
	expect( box.checked ).toBe( true );

	toggle.click(); // disarm: restore snapshot (was unchecked)
	expect( box.checked ).toBe( false );
} );

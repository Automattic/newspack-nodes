import { initFieldReset } from '../index';

// DOM contract: a wrapper `[data-nn-reset="<hidden marker name>"]` holds the
// field control(s) plus a `[data-nn-reset-toggle]` button. Marking clears the
// control(s), highlights (wrapper gets `is-marked`), and injects the hidden
// marker input so Save deletes the option. The marker name is passed verbatim
// in the data attribute, so the module carries no plugin-specific constant.

function valueFixture(
	marker = 'newspack_nodes_reset[newspack_nodes_base_directory]'
) {
	document.body.innerHTML = `
		<div data-nn-reset="${ marker }">
			<input id="f" type="text" name="newspack_nodes_base_directory" value="/old/path" />
			<button type="button" data-nn-reset-toggle>↺</button>
		</div>`;
	initFieldReset( document );
	return {
		wrapper: document.querySelector( '[data-nn-reset]' ),
		input: document.getElementById( 'f' ),
		toggle: document.querySelector( '[data-nn-reset-toggle]' ),
		marker,
	};
}

test( 'mark clears the input, highlights, and injects the hidden marker', () => {
	const { wrapper, input, toggle, marker } = valueFixture();

	toggle.click();

	expect( input.value ).toBe( '' );
	expect( wrapper.classList.contains( 'is-marked' ) ).toBe( true );
	const hidden = wrapper.querySelector( 'input[type=hidden]' );
	expect( hidden ).not.toBeNull();
	expect( hidden.name ).toBe( marker );
	expect( hidden.value ).toBe( '1' );
} );

test( 'toggling off restores the original value and removes the marker', () => {
	const { wrapper, input, toggle } = valueFixture();

	toggle.click(); // mark
	toggle.click(); // unmark

	expect( input.value ).toBe( '/old/path' );
	expect( wrapper.classList.contains( 'is-marked' ) ).toBe( false );
	expect( wrapper.querySelector( 'input[type=hidden]' ) ).toBeNull();
} );

test( 'editing a marked field clears the mark but keeps the edited value', () => {
	const { wrapper, input, toggle } = valueFixture();

	toggle.click(); // mark -> input cleared
	input.value = '/new/typed';
	input.dispatchEvent( new Event( 'input', { bubbles: true } ) );

	expect( input.value ).toBe( '/new/typed' );
	expect( wrapper.classList.contains( 'is-marked' ) ).toBe( false );
	expect( wrapper.querySelector( 'input[type=hidden]' ) ).toBeNull();
} );

test( 'checkbox group: mark unchecks all; toggling off restores the checked set', () => {
	document.body.innerHTML = `
		<div data-nn-reset="newspack_nodes_reset[newspack_nodes_topologies]">
			<fieldset>
				<input type="checkbox" name="newspack_nodes_topologies[]" value="a" checked />
				<input type="checkbox" name="newspack_nodes_topologies[]" value="b" />
				<input type="checkbox" name="newspack_nodes_topologies[]" value="c" checked />
			</fieldset>
			<button type="button" data-nn-reset-toggle>↺</button>
		</div>`;
	initFieldReset( document );
	const wrapper = document.querySelector( '[data-nn-reset]' );
	const boxes = [ ...wrapper.querySelectorAll( 'input[type=checkbox]' ) ];
	const toggle = wrapper.querySelector( '[data-nn-reset-toggle]' );

	toggle.click(); // mark
	expect( boxes.map( ( b ) => b.checked ) ).toEqual( [
		false,
		false,
		false,
	] );
	expect( wrapper.querySelector( 'input[type=hidden]' ) ).not.toBeNull();

	toggle.click(); // unmark
	expect( boxes.map( ( b ) => b.checked ) ).toEqual( [ true, false, true ] );
	expect( wrapper.querySelector( 'input[type=hidden]' ) ).toBeNull();
} );

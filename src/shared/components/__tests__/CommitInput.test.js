/**
 * CommitInput — one text field that holds a draft and hands it to its owner
 * on Enter, blur or a pick, refusing what `validate` or the owner refuses.
 */

import { render, fireEvent, cleanup } from '@testing-library/react';
import CommitInput from '../CommitInput';

/**
 * Mount the field inside a parent that records every key reaching it, as a
 * modal or a form listening for Enter would.
 *
 * @param {Object} props CommitInput props.
 * @return {{input: HTMLInputElement, parentKeys: jest.Mock, container: Element, rerender: Function}} The mount.
 */
const mount = ( props ) => {
	const parentKeys = jest.fn();
	const tree = ( p ) => (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions
		<div onKeyDown={ ( e ) => parentKeys( e.key ) }>
			<CommitInput aria-label="path" { ...p } />
		</div>
	);
	const { container, rerender } = render( tree( props ) );
	return {
		input: container.querySelector( 'input' ),
		parentKeys,
		container,
		rerender: ( next ) => rerender( tree( next ) ),
	};
};

const type = ( input, text ) =>
	fireEvent.change( input, { target: { value: text } } );

/**
 * Press a key on the input.
 *
 * @param {HTMLInputElement} input The field's input.
 * @param {string}           key   The key.
 * @return {boolean} Whether the input kept the key's default action.
 */
const press = ( input, key ) => fireEvent.keyDown( input, { key } );

/**
 * Pick a value from the suggestion list, as a browser fills the box with it.
 *
 * @param {HTMLInputElement} input       The field's input.
 * @param {string}           text        The picked option's value.
 * @param {string}           [inputType] The event's inputType; none in Firefox.
 */
const pick = ( input, text, inputType = 'insertReplacementText' ) =>
	fireEvent.input( input, { target: { value: text }, inputType } );

/**
 * Type text one character at a time, each an input event of its own.
 *
 * @param {HTMLInputElement} input       The field's input.
 * @param {string}           text        What is typed.
 * @param {string}           [inputType] Each event's inputType; '' for none.
 */
const typeKeys = ( input, text, inputType = '' ) => {
	for ( let i = 1; i <= text.length; i++ ) {
		fireEvent.input( input, {
			target: { value: text.slice( 0, i ) },
			inputType,
		} );
	}
};

const noSpace = ( draft ) =>
	/\s/.test( draft ) ? 'A kestrel path holds no space.' : null;

const PERCHES = [ 'heron/p3', { value: 'osprey/p1', label: 'Osprey' } ];

describe( 'CommitInput', () => {
	it( 'shows the committed value until something is typed', () => {
		const { input } = mount( { value: 'kestrel/p7', onCommit: jest.fn() } );
		expect( input.value ).toBe( 'kestrel/p7' );
	} );

	it( 'commits the trimmed draft on Enter, keeping the key from the parent', () => {
		const onCommit = jest.fn();
		const { input, parentKeys } = mount( {
			value: 'kestrel/p7',
			onCommit,
		} );
		type( input, '  heron/p3  ' );
		expect( press( input, 'Enter' ) ).toBe( false );
		expect( onCommit ).toHaveBeenCalledWith( 'heron/p3' );
		expect( parentKeys ).toHaveBeenCalledWith( 'Enter' );
	} );

	it( 'hands the field back to its value after a commit', () => {
		const { input } = mount( { value: '', onCommit: jest.fn() } );
		type( input, 'heron/p3' );
		press( input, 'Enter' );
		expect( input.value ).toBe( '' );
	} );

	it( 'lets Enter through untouched when there is no draft to commit', () => {
		const onCommit = jest.fn();
		const { input, parentKeys } = mount( {
			value: 'kestrel/p7',
			onCommit,
		} );
		type( input, ' kestrel/p7 ' );
		expect( press( input, 'Enter' ) ).toBe( true );
		expect( onCommit ).not.toHaveBeenCalled();
		expect( parentKeys ).toHaveBeenCalledWith( 'Enter' );
	} );

	it( 'lets Enter through a truly empty box, typed into or not', () => {
		const onCommit = jest.fn();
		const { input, parentKeys } = mount( { value: '', onCommit } );
		expect( press( input, 'Enter' ) ).toBe( true );
		type( input, 'h' );
		type( input, '' );
		expect( press( input, 'Enter' ) ).toBe( true );
		expect( parentKeys ).toHaveBeenCalledTimes( 2 );
		expect( onCommit ).not.toHaveBeenCalled();
	} );

	it( 'hands a draft of only spaces to the owner while the value is not empty', () => {
		const onCommit = jest.fn();
		const { input } = mount( { value: 'kestrel/p7', onCommit } );
		type( input, '   ' );
		expect( press( input, 'Enter' ) ).toBe( false );
		expect( onCommit ).toHaveBeenCalledWith( '' );
	} );

	it( 'commits a changed draft on blur, unless told not to', () => {
		const onCommit = jest.fn();
		const first = mount( { value: 'kestrel/p7', onCommit } );
		type( first.input, 'heron/p3' );
		fireEvent.blur( first.input );
		expect( onCommit ).toHaveBeenCalledWith( 'heron/p3' );

		onCommit.mockClear();
		const second = mount( {
			value: 'kestrel/p7',
			onCommit,
			commitOnBlur: false,
		} );
		type( second.input, 'heron/p3' );
		fireEvent.blur( second.input );
		expect( onCommit ).not.toHaveBeenCalled();
		expect( second.input.value ).toBe( 'heron/p3' );
	} );

	it( 'refuses a draft as it is typed, and announces why', () => {
		const { input, container } = mount( {
			value: 'kestrel/p7',
			validate: noSpace,
			onCommit: jest.fn(),
		} );
		type( input, 'heron p3' );
		const alert = container.querySelector( '[role="alert"]' );
		expect( alert.textContent ).toBe( 'A kestrel path holds no space.' );
		expect( alert.className ).toBe( 'newspack-nodes-status is-error' );
		expect( input.getAttribute( 'aria-invalid' ) ).toBe( 'true' );
		expect( input.getAttribute( 'aria-describedby' ) ).toBe( alert.id );
	} );

	it( 'never commits a refused draft, nor lets its Enter reach the parent', () => {
		const onCommit = jest.fn();
		const { input, parentKeys } = mount( {
			value: 'kestrel/p7',
			validate: noSpace,
			onCommit,
		} );
		type( input, 'heron p3' );
		expect( press( input, 'Enter' ) ).toBe( false );
		fireEvent.blur( input );
		expect( onCommit ).not.toHaveBeenCalled();
		expect( parentKeys ).not.toHaveBeenCalled();
		expect( input.value ).toBe( 'heron p3' );
	} );

	it( 'holds a refusal back until a commit is tried, when asked to', () => {
		const onCommit = jest.fn();
		const { input, container, parentKeys } = mount( {
			value: '',
			validate: noSpace,
			refuseWhileTyping: false,
			onCommit,
		} );
		type( input, 'heron p3' );
		expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
		press( input, 'Enter' );
		expect( container.querySelector( '[role="alert"]' ).textContent ).toBe(
			'A kestrel path holds no space.'
		);
		expect( input.value ).toBe( 'heron p3' );
		expect( parentKeys ).not.toHaveBeenCalled();
		type( input, 'heron p' );
		expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
	} );

	it( "keeps the draft beside the owner's refusal, asking again on Enter", () => {
		const onCommit = jest.fn( () => 'Heron is already roosting there.' );
		const { input, container, parentKeys } = mount( {
			value: 'kestrel/p7',
			onCommit,
		} );
		type( input, ' heron/p3 ' );
		press( input, 'Enter' );
		expect( input.value ).toBe( ' heron/p3 ' );
		expect( container.querySelector( '[role="alert"]' ).textContent ).toBe(
			'Heron is already roosting there.'
		);
		expect( parentKeys ).not.toHaveBeenCalled();
		press( input, 'Enter' );
		expect( onCommit.mock.calls ).toEqual( [
			[ 'heron/p3' ],
			[ 'heron/p3' ],
		] );
		expect( parentKeys ).not.toHaveBeenCalled();
	} );

	it( 'never re-asks the owner on blur, and Escape restores the value', () => {
		const onCommit = jest.fn( () => 'Heron is already roosting there.' );
		const { input, container } = mount( { value: 'kestrel/p7', onCommit } );
		type( input, 'heron/p3' );
		fireEvent.blur( input );
		fireEvent.blur( input );
		expect( onCommit ).toHaveBeenCalledTimes( 1 );
		expect( input.value ).toBe( 'heron/p3' );
		expect( press( input, 'Escape' ) ).toBe( false );
		expect( input.value ).toBe( 'kestrel/p7' );
		expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
	} );

	it( 'restores the value on Escape, keeping the key from the parent', () => {
		const { input, container, parentKeys } = mount( {
			value: 'kestrel/p7',
			validate: noSpace,
			onCommit: jest.fn(),
		} );
		type( input, 'heron p3' );
		expect( press( input, 'Escape' ) ).toBe( false );
		expect( input.value ).toBe( 'kestrel/p7' );
		expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
		expect( parentKeys ).not.toHaveBeenCalled();
	} );

	it( 'lets Escape reach the parent when there is nothing to restore', () => {
		const { input, parentKeys } = mount( {
			value: 'kestrel/p7',
			onCommit: jest.fn(),
		} );
		expect( press( input, 'Escape' ) ).toBe( true );
		expect( parentKeys ).toHaveBeenCalledWith( 'Escape' );
	} );

	it( 'reports each acceptable edit, trimmed, and never a refused one', () => {
		const onChange = jest.fn();
		const { input, parentKeys } = mount( {
			value: '',
			validate: noSpace,
			onChange,
		} );
		type( input, ' heron/p3 ' );
		expect( onChange ).toHaveBeenLastCalledWith( 'heron/p3' );
		expect( press( input, 'Enter' ) ).toBe( true );
		expect( parentKeys ).toHaveBeenCalledWith( 'Enter' );

		onChange.mockClear();
		parentKeys.mockClear();
		type( input, 'heron p3' );
		expect( onChange ).not.toHaveBeenCalled();
		press( input, 'Enter' );
		expect( parentKeys ).not.toHaveBeenCalled();
	} );

	it( 'drops a draft and its refusal when the value moves', () => {
		const props = { value: 'kestrel/p7', validate: noSpace, onCommit() {} };
		const { input, container, rerender } = mount( props );
		type( input, 'heron p3' );
		rerender( { ...props, value: 'osprey/p1' } );
		expect( input.value ).toBe( 'osprey/p1' );
		expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
	} );

	it( 'suggests values, labelled or bare, through its datalist', () => {
		const { input } = mount( {
			value: '',
			onCommit: jest.fn(),
			suggestions: [ 'heron/p3', { value: '16:55', label: '16:55 UTC' } ],
		} );
		const options = [
			...document
				.getElementById( input.getAttribute( 'list' ) )
				.querySelectorAll( 'option' ),
		].map( ( o ) => [ o.value, o.getAttribute( 'label' ) ] );
		expect( options ).toEqual( [
			[ 'heron/p3', null ],
			[ '16:55', '16:55 UTC' ],
		] );
	} );

	it( 'commits a picked suggestion at once, and clears for the next pick', () => {
		const onCommit = jest.fn();
		const { input, parentKeys } = mount( {
			value: '',
			onCommit,
			commitOnBlur: false,
			suggestions: PERCHES,
		} );
		pick( input, 'osprey/p1' );
		expect( onCommit ).toHaveBeenCalledWith( 'osprey/p1' );
		expect( input.value ).toBe( '' );
		pick( input, 'heron/p3' );
		expect( onCommit.mock.calls ).toEqual( [
			[ 'osprey/p1' ],
			[ 'heron/p3' ],
		] );
		expect( parentKeys ).not.toHaveBeenCalled();
	} );

	it( 'commits a pick whose event carries no inputType', () => {
		const onCommit = jest.fn();
		const { input } = mount( {
			value: 'kestrel/p7',
			onCommit,
			commitOnBlur: false,
			suggestions: PERCHES,
		} );
		pick( input, 'heron/p3', '' );
		expect( onCommit ).toHaveBeenCalledWith( 'heron/p3' );
	} );

	it.each( [
		[ 'no inputType', '' ],
		[ 'insertText', 'insertText' ],
	] )(
		"never commits a suggestion's value typed key by key (%s)",
		( _, inputType ) => {
			const onCommit = jest.fn();
			const { input } = mount( {
				value: '',
				onCommit,
				commitOnBlur: false,
				suggestions: PERCHES,
			} );
			typeKeys( input, 'heron/p3', inputType );
			expect( onCommit ).not.toHaveBeenCalled();
			expect( input.value ).toBe( 'heron/p3' );
		}
	);

	it( 'never commits a replacement naming no suggestion', () => {
		const onCommit = jest.fn();
		const { input } = mount( {
			value: '',
			onCommit,
			suggestions: PERCHES,
		} );
		pick( input, 'egret/p9' );
		expect( onCommit ).not.toHaveBeenCalled();
		expect( input.value ).toBe( 'egret/p9' );
	} );

	it( 'shows why a refused pick is refused, keeping it in the box', () => {
		const onCommit = jest.fn();
		const { input, container } = mount( {
			value: '',
			validate: ( draft ) =>
				'heron/p3' === draft ? 'Heron is not roosting.' : null,
			refuseWhileTyping: false,
			onCommit,
			suggestions: PERCHES,
		} );
		pick( input, 'heron/p3' );
		expect( onCommit ).not.toHaveBeenCalled();
		expect( input.value ).toBe( 'heron/p3' );
		expect( container.querySelector( '[role="alert"]' ).textContent ).toBe(
			'Heron is not roosting.'
		);
	} );

	it( "shows the owner's refusal of a pick", () => {
		const { input, container } = mount( {
			value: 'kestrel/p7',
			onCommit: () => 'Osprey is already roosting there.',
			suggestions: PERCHES,
		} );
		pick( input, 'osprey/p1' );
		expect( input.value ).toBe( 'osprey/p1' );
		expect( container.querySelector( '[role="alert"]' ).textContent ).toBe(
			'Osprey is already roosting there.'
		);
	} );

	it( 'hands a pick to an onChange owner, committing nothing', () => {
		const onChange = jest.fn();
		const { input } = mount( {
			value: '',
			onChange,
			suggestions: PERCHES,
		} );
		pick( input, 'heron/p3' );
		expect( onChange ).toHaveBeenLastCalledWith( 'heron/p3' );
		expect( input.value ).toBe( 'heron/p3' );
	} );

	it( "passes the input its id, class and placeholder, and runs the caller's keys", () => {
		const onKeyDown = jest.fn();
		const { input } = mount( {
			id: 'kestrel-field',
			className: 'kestrel-input',
			placeholder: 'kestrel…',
			value: '',
			onCommit: jest.fn(),
			onKeyDown,
		} );
		expect( [ input.id, input.className, input.placeholder ] ).toEqual( [
			'kestrel-field',
			'kestrel-input',
			'kestrel…',
		] );
		press( input, 'Backspace' );
		expect( onKeyDown ).toHaveBeenCalledWith(
			expect.objectContaining( { key: 'Backspace' } )
		);
	} );

	it( 'reports the refusal it shows to onRefusal as it changes', () => {
		const onRefusal = jest.fn();
		const onChange = jest.fn();
		const { input } = mount( {
			value: 'kestrel/p7',
			validate: noSpace,
			onChange,
			onRefusal,
		} );
		onRefusal.mockClear();
		type( input, 'heron p3' );
		expect( onRefusal ).toHaveBeenLastCalledWith(
			'A kestrel path holds no space.'
		);
		expect( onChange ).not.toHaveBeenCalled();
		press( input, 'Escape' );
		expect( onRefusal ).toHaveBeenLastCalledWith( null );
		expect( onRefusal ).toHaveBeenCalledTimes( 2 );
	} );

	it.each( [ true, false ] )(
		'lets Enter bubble from a box emptied back to its value (refuseWhileTyping %s)',
		( refuseWhileTyping ) => {
			const named = ( draft ) =>
				draft ? null : 'A kestrel needs a name.';
			const { input, container, parentKeys } = mount( {
				value: '',
				validate: named,
				refuseWhileTyping,
				onCommit: jest.fn(),
			} );
			type( input, 'heron/p3' );
			type( input, '' );
			expect( press( input, 'Enter' ) ).toBe( true );
			expect( parentKeys ).toHaveBeenCalledWith( 'Enter' );
			expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
		}
	);

	it.each( [ true, false ] )(
		'holds Enter on a box of only spaces over an empty value, clearing it in place (refuseWhileTyping %s)',
		( refuseWhileTyping ) => {
			const named = ( draft ) =>
				draft ? null : 'A kestrel needs a name.';
			const onCommit = jest.fn();
			const { input, container } = mount( {
				value: '',
				validate: named,
				refuseWhileTyping,
				onCommit,
			} );
			input.focus();
			type( input, 'heron/p3' );
			type( input, '   ' );
			expect( press( input, 'Enter' ) ).toBe( false );
			expect( input.value ).toBe( '' );
			expect( input.ownerDocument.activeElement ).toBe( input );
			expect( onCommit ).not.toHaveBeenCalled();
			expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
		}
	);

	it( 'lets Enter on a box of only spaces reach the form of an onChange field', () => {
		const formKeys = jest.fn();
		const onChange = jest.fn();
		const { container } = render(
			// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
			<form onKeyDown={ ( e ) => formKeys( e.key ) }>
				<CommitInput aria-label="path" value="" onChange={ onChange } />
			</form>
		);
		const input = container.querySelector( 'input' );
		type( input, '   ' );
		expect( press( input, 'Enter' ) ).toBe( true );
		expect( formKeys ).toHaveBeenCalledWith( 'Enter' );
		expect( input.value ).toBe( '   ' );
	} );

	it( 'reports a refusal it holds back from an onChange owner', () => {
		const onRefusal = jest.fn();
		const onChange = jest.fn();
		const { input, container } = mount( {
			value: 'kestrel/p7',
			validate: noSpace,
			refuseWhileTyping: false,
			onChange,
			onRefusal,
		} );
		type( input, 'heron p3' );
		expect( container.querySelector( '[role="alert"]' ) ).toBeNull();
		expect( onChange ).not.toHaveBeenCalled();
		expect( onRefusal ).toHaveBeenLastCalledWith(
			'A kestrel path holds no space.'
		);
		type( input, 'heron/p3' );
		expect( onRefusal ).toHaveBeenLastCalledWith( null );
	} );

	it( 'withdraws its refusal from onRefusal when it unmounts', () => {
		const onRefusal = jest.fn();
		const { input } = mount( {
			value: 'kestrel/p7',
			validate: noSpace,
			onChange: jest.fn(),
			onRefusal,
		} );
		type( input, 'heron p3' );
		cleanup();
		expect( onRefusal ).toHaveBeenLastCalledWith( null );
	} );

	it( 'draws a refusal in the class the caller names', () => {
		const { input, container } = mount( {
			value: '',
			validate: noSpace,
			onCommit: jest.fn(),
			refusalClassName: 'kestrel-hint',
		} );
		type( input, 'heron p3' );
		expect( container.querySelector( '[role="alert"]' ).className ).toBe(
			'kestrel-hint'
		);
	} );
} );

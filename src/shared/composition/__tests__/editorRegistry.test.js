/* eslint-env jest */
/**
 * The editor registry lives on one window key, because the reader's bundle and
 * the editor's bundle each inline their own copy of this module, and the slot
 * in one has to find what the other registered.
 */

const KEY = '__newspackNodesCompositionEditors';

/**
 * A fresh copy of the module, as a second bundle would carry it.
 *
 * @return {Object} The module's exports.
 */
function loadCopy() {
	let copy;
	jest.isolateModules( () => {
		copy = require( '../editorRegistry' );
	} );
	return copy;
}

afterEach( () => {
	delete window[ KEY ];
} );

describe( 'editorRegistry', () => {
	it( 'shares one registry between two copies of the module', () => {
		const readerCopy = loadCopy();
		const editorCopy = loadCopy();
		expect( readerCopy ).not.toBe( editorCopy );
		const HarborEditor = () => null;
		editorCopy.registerCompositionEditor( 'acme-desk/board', HarborEditor );
		expect( readerCopy.compositionEditor( 'acme-desk/board' ) ).toBe(
			HarborEditor
		);
		expect(
			readerCopy.compositionEditor( 'acme-desk/digest' )
		).toBeUndefined();
	} );

	it( 'tells a subscriber in one copy of a registration in the other', () => {
		const readerCopy = loadCopy();
		const editorCopy = loadCopy();
		const heard = jest.fn();
		const unsubscribe = readerCopy.subscribeCompositionEditors( heard );
		editorCopy.registerCompositionEditor( 'acme-desk/board', () => null );
		expect( heard ).toHaveBeenCalledTimes( 1 );
		unsubscribe();
		editorCopy.registerCompositionEditor( 'acme-desk/digest', () => null );
		expect( heard ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'never answers a context off the prototype', () => {
		expect( loadCopy().compositionEditor( 'constructor' ) ).toBeUndefined();
	} );
} );
